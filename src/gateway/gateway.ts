// The gateway: the one way to call a model. It owns everything that keeps a
// request alive when a provider isn't: a timeout per attempt and a deadline
// per request, retries with backoff on the errors worth retrying, a circuit
// breaker per provider, the fallback provider, and one repair retry for an
// answer that fails validation.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SpanKind, trace } from "@opentelemetry/api";
import { pino, type Logger } from "pino";
import { parse } from "yaml";
import { z } from "zod";
import { Metrics } from "../metrics/metrics.js";
import { paths, rel } from "../paths.js";
import { captureIO, decision, failSpan, tracer } from "../tracing/tracing.js";
import { cacheKey, type CacheKeyParts, type ResponseCache } from "./cache.js";
import { Circuit } from "./circuit.js";
import { isMock, loadModelsConfig, resolveChain, type ModelsConfig, type ProviderName, type ResolvedModel } from "./config.js";
import { ProviderError, RETRYABLE, type ErrorClass } from "./errors.js";
import { mockSetupFromEnv, type MockSetup } from "./mock.js";
import { classify, createProvider, missingKey, type ChatMessage, type ChatResponse, type Provider } from "./providers.js";

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

export type GatewayRequest<T> = {
  /** The prompt's model alias. Its `fallback` alias in config/models.yaml is the fallback. */
  alias: string;
  /** Starts the chain on this provider instead (`--provider`, DISPATCH_PROVIDER). */
  provider?: ProviderName;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  /** Checks the model's text. A failure gets one repair retry with this message. */
  validate: (raw: string) => Validation<T>;
  /** Eval-only response cache, with what identifies the call apart from the provider and model. */
  cache?: { store: ResponseCache; parts: Omit<CacheKeyParts, "provider" | "model" | "params" | "repair">; refresh: boolean };
  /** Where this request's attempt lines go: the server passes a logger carrying the request id. */
  log?: Logger;
};

export type GatewayMeta = {
  provider: ProviderName;
  model: string;
  /** Answered by the fallback provider, not the primary. */
  fallback: boolean;
  /** Retries after a failed attempt, over every provider tried. */
  retries: number;
  /** The first answer failed validation and the repair call was made. */
  repaired: boolean;
  /** Summed over every call the request made. */
  tokensIn: number;
  tokensOut: number;
  /** The whole request, retries and waits included, minus waiting for a free-tier slot. */
  latencyMs: number;
  /** Every call came from the eval cache: the latency is the original's. */
  cached: boolean;
};

export type GatewayResult<T> = ({ ok: true; value: T } | { ok: false; message: string; raw: string }) & GatewayMeta;

export type Decision = "success" | "retry" | "repair" | "fallback" | "give_up";

export type GatewayOptions = {
  config?: ModelsConfig;
  /** Per-mock failure modes. Defaults to MOCK_MODE and friends from the environment. */
  mocks?: Partial<MockSetup>;
  /** For circuit changes and requests without their own logger. Silent by default. */
  log?: Logger;
  /** Jitter source, so tests can pin the backoff. */
  random?: () => number;
  /** Where attempts, errors, tokens and circuit states are counted. A private one by default (the eval has no /metrics). */
  metrics?: Metrics;
};

const RepairPromptSchema = z.strictObject({
  message: z.string().includes("{{error}}", { message: "must contain {{error}} where the validation error goes" }),
});
let repairPrompt: { message: string; sha256: string } | undefined;
function loadRepairPrompt(): { message: string; sha256: string } {
  if (!repairPrompt) {
    const text = readFileSync(paths.repairPrompt, "utf8");
    const parsed = RepairPromptSchema.safeParse(parse(text));
    if (!parsed.success) throw new Error(`${rel(paths.repairPrompt)} is invalid:\n${z.prettifyError(parsed.error)}`);
    repairPrompt = { message: parsed.data.message, sha256: createHash("sha256").update(text).digest("hex") };
  }
  return repairPrompt;
}

// Failures that say the provider is unwell. A 400 or a broken answer means it
// answered: that doesn't count against it.
const COUNTS_AGAINST_CIRCUIT: ReadonlySet<ErrorClass> = new Set(["rate_limit", "timeout", "provider_5xx", "connection", "auth"]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Holds one provider and one circuit of each kind, shared by every call in the process. */
export class Gateway {
  private readonly providers = new Map<ProviderName, Provider>();
  private readonly circuits = new Map<ProviderName, Circuit>();
  private readonly config: ModelsConfig;
  private readonly mocks: MockSetup;
  private readonly log: Logger;
  private readonly random: () => number;
  private readonly metrics: Metrics;

  constructor(opts: GatewayOptions = {}) {
    this.config = opts.config ?? loadModelsConfig();
    const fromEnv = opts.mocks?.mock && opts.mocks.mock_fallback ? undefined : mockSetupFromEnv();
    this.mocks = { mock: opts.mocks?.mock ?? fromEnv?.mock ?? {}, mock_fallback: opts.mocks?.mock_fallback ?? fromEnv?.mock_fallback ?? {} };
    this.log = opts.log ?? pino({ level: "silent" });
    this.random = opts.random ?? Math.random;
    this.metrics = opts.metrics ?? new Metrics();
    this.metrics.readCircuits(() => [...this.circuits].map(([name, c]) => [name, c.current()] as const));
  }

  /** The providers a call may use, in order. */
  chain(alias: string, provider?: ProviderName): ResolvedModel[] {
    return resolveChain(this.config, alias, provider);
  }

  /** Makes every provider in the chain now, so a missing key fails before the first request. */
  prepare(alias: string, provider?: ProviderName): void {
    const chain = this.chain(alias, provider);
    for (const [i, m] of chain.entries()) {
      this.provider(m.provider);
      // Made now so /metrics shows every circuit as closed before the first request.
      this.circuit(m.provider);
      this.metrics.provider(m.provider);
      const prev = chain[i - 1];
      if (prev) this.metrics.fallbackPair(prev.provider, m.provider);
    }
  }

  /** Why the chain can't serve, or undefined if it can. For /readyz. */
  notReady(alias: string, provider?: ProviderName): string | undefined {
    const chain = this.chain(alias, provider);
    for (const m of chain) {
      const problem = missingKey(this.config, m.provider);
      if (problem) return problem.split("\n")[0];
    }
    if (chain.every((m) => this.circuit(m.provider).current() === "open")) {
      return `every provider's circuit is open (${chain.map((m) => m.provider).join(", ")})`;
    }
    return undefined;
  }

  provider(name: ProviderName): Provider {
    let p = this.providers.get(name);
    if (!p) {
      p = createProvider(name, isMock(name) ? this.mocks[name] : {}, this.config);
      this.providers.set(name, p);
    }
    return p;
  }

  circuit(name: ProviderName): Circuit {
    let c = this.circuits.get(name);
    if (!c) {
      c = new Circuit(this.config.gateway.circuit, ({ from, to }) => {
        this.log.warn({ event: "gateway.circuit", provider: name, from, to }, `circuit ${name}: ${from} -> ${to}`);
      });
      this.circuits.set(name, c);
    }
    return c;
  }

  /**
   * One model request: tries the chain in order and returns the first valid
   * answer, or the first answer that is still invalid after its repair.
   * Throws a ProviderError when no provider answered.
   */
  async call<T>(req: GatewayRequest<T>): Promise<GatewayResult<T>> {
    const g = this.config.gateway;
    const log = req.log ?? this.log;
    const started = Date.now();
    // Moved forward by every wait for a free-tier slot: that's our queue, not the provider.
    let deadline = started + g.deadline_ms;
    let paced = 0;
    let retries = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let calls = 0;
    let cachedCalls = 0;
    let cachedLatency = 0;
    let lastError: ProviderError | undefined;

    const chain = this.chain(req.alias, req.provider);

    // Timeouts from an attempt our own deadline cut short: they say little about
    // the provider, so they aren't held against it. Silent for half an attempt
    // timeout (5 s) or more is its fault: a healthy provider answers in 1-2 s,
    // and a hung primary always gets a few ms under the full 10 s.
    const cutByUs = new WeakSet<ProviderError>();

    // One call to one provider: from the cache, or a real attempt under the
    // attempt timeout and what's left of the deadline. The circuit hears only
    // about real attempts: a cache hit never closes (or opens) it. Each call
    // is one gen_ai.chat span, checked answer included, so a schema_fail
    // shows on the attempt that produced it.
    const send = async (
      provider: Provider,
      circuit: Circuit,
      model: ResolvedModel,
      end: () => number,
      messages: ChatMessage[],
      at: { attempt: number; fallback: boolean },
      repair?: CacheKeyParts["repair"],
    ): Promise<{ res: ChatResponse; checked: Validation<T> }> => {
      calls++;
      const key = req.cache && cacheKey({ ...req.cache.parts, provider: model.provider, model: model.model, params: model.params, ...(repair ? { repair } : {}) });
      const hit = key && !req.cache?.refresh ? req.cache?.store.get(key) : undefined;

      if (!hit) {
        const waitStart = Date.now();
        await provider.pace();
        const waited = Date.now() - waitStart;
        paced += waited;
        deadline += waited;
        // Drawn after the fact: a slow request is often just our own queue for a free-tier slot.
        if (waited > 0) {
          tracer()
            .startSpan("gateway.pace_wait", { startTime: waitStart, attributes: { "app.provider": model.provider, "app.wait_ms": waited } })
            .end(waitStart + waited);
        }
      }

      const span = tracer().startSpan("gen_ai.chat", {
        kind: SpanKind.CLIENT,
        attributes: {
          "langfuse.observation.type": "generation",
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": this.config.providers[model.provider].otel_name ?? model.provider,
          "gen_ai.request.model": model.model,
          "gen_ai.request.temperature": req.temperature,
          "gen_ai.request.max_tokens": req.maxTokens,
          "server.address": new URL(this.config.providers[model.provider].base_url).hostname,
          "app.provider": model.provider,
          "app.attempt": at.attempt,
          "app.fallback": at.fallback,
          "app.repair": repair !== undefined,
          "app.cache_hit": hit !== undefined,
        },
      });
      try {
        let res: ChatResponse;
        if (hit) {
          circuit.release();
          cachedCalls++;
          cachedLatency += hit.latencyMs;
          res = hit;
        } else {
          const budget = Math.max(0, end() - Date.now());
          const controller = new AbortController();
          const attemptStart = performance.now();
          const timer = setTimeout(() => {
            controller.abort(new Error("attempt timed out"));
          }, Math.min(g.attempt_timeout_ms, budget));
          try {
            res = await provider.complete({ model: model.model, messages, temperature: req.temperature, maxTokens: req.maxTokens, params: model.params }, controller.signal);
          } catch (err) {
            // Only the provider call is classified: a fault of ours (the cache, a
            // prompt file) must never read as the provider failing.
            const classified = classify(err, model.provider, controller.signal);
            if (classified.errorClass === "timeout" && budget < g.attempt_timeout_ms / 2) cutByUs.add(classified);
            failSpan(span, classified.errorClass);
            this.metrics.gatewayError(model.provider, classified.errorClass);
            throw classified;
          } finally {
            clearTimeout(timer);
            this.metrics.attempt(model.provider, (performance.now() - attemptStart) / 1000);
          }
          // Real calls only: a cache hit cost nothing the second time.
          this.metrics.usage(model.provider, res.tokensIn, res.tokensOut, model.price);
          circuit.success();
          // Stored as soon as it arrives, so an eval stopped by a rate limit picks up here.
          if (key) req.cache?.store.set(key, res);
        }
        tokensIn += res.tokensIn;
        tokensOut += res.tokensOut;
        span.setAttributes({
          "gen_ai.usage.input_tokens": res.tokensIn,
          "gen_ai.usage.output_tokens": res.tokensOut,
          ...(res.finishReason ? { "gen_ai.response.finish_reasons": [res.finishReason] } : {}),
        });
        captureIO(span, { input: messages.at(-1)?.content ?? "", output: res.content });
        const checked = req.validate(res.content);
        if (!checked.ok) failSpan(span, "schema_fail");
        return { res, checked };
      } finally {
        span.end();
      }
    };

    const meta = (model: ResolvedModel, index: number, repaired: boolean): GatewayMeta => {
      const allCached = calls > 0 && cachedCalls === calls;
      return {
        provider: model.provider,
        model: model.model,
        fallback: index > 0,
        retries,
        repaired,
        tokensIn,
        tokensOut,
        latencyMs: allCached ? cachedLatency : Date.now() - started - paced,
        cached: allCached,
      };
    };

    const messages: ChatMessage[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];

    for (const [index, model] of chain.entries()) {
      const isLast = index === chain.length - 1;
      const next: Decision = isLast ? "give_up" : "fallback";
      // A hung primary must not eat the whole deadline: one attempt's worth is
      // kept back for the fallback, but only if a later provider can take it.
      const fallbackUp = chain.slice(index + 1).some((m) => this.circuit(m.provider).current() !== "open");
      const reserve = fallbackUp ? Math.min(g.attempt_timeout_ms, g.deadline_ms / 2) : 0;
      const end = () => deadline - reserve;
      const provider = this.provider(model.provider);
      const circuit = this.circuit(model.provider);
      const line = { provider: model.provider, model: model.model };
      // Set once this provider's answer failed validation. From then on its
      // attempts send the repair, so a retried repair call stays a repair.
      // Once per provider: a fallback's broken answer gets its own repair.
      let toRepair: { raw: string; error: string } | undefined;

      if (index > 0) {
        const from = chain[index - 1]?.provider ?? "gateway";
        decision("gateway.fallback", { "app.from": from, "app.to": model.provider, "app.error_class": lastError?.errorClass ?? "circuit_open" });
        const prev = chain[index - 1];
        if (prev) this.metrics.fallback(prev.provider, model.provider);
      }

      for (let attempt = 1; attempt <= g.max_retries + 1; attempt++) {
        const at = { attempt, fallback: index > 0 };
        if (end() - Date.now() <= 0) {
          // Out of this provider's time. Not a failure of the provider: nothing was sent.
          log.warn({ event: "gateway.skip", ...line, attempt, error_class: "timeout", wait_ms: null, decision: next, reason: "no time left" }, `${model.provider} skipped: no time left`);
          decision("gateway.skip", { "app.provider": model.provider, "app.attempt": attempt, "app.error_class": "timeout", "app.reason": "no time left" });
          this.metrics.gatewayError(model.provider, "timeout");
          lastError ??= new ProviderError("timeout", `no time left before the ${String(g.deadline_ms / 1000)} s deadline`, model.provider);
          break;
        }
        if (!circuit.allow()) {
          // Open circuit: skipped at once, no timeout to wait out.
          log.warn({ event: "gateway.skip", ...line, attempt, error_class: "circuit_open", wait_ms: null, decision: next }, `${model.provider} skipped: circuit open`);
          decision("gateway.skip", { "app.provider": model.provider, "app.attempt": attempt, "app.error_class": "circuit_open", "app.reason": "circuit open" });
          this.metrics.gatewayError(model.provider, "circuit_open");
          break;
        }
        const attemptStart = Date.now();
        const pacedBefore = paced;
        const elapsed = () => Date.now() - attemptStart - (paced - pacedBefore);
        try {
          if (!toRepair) {
            const { res: first, checked } = await send(provider, circuit, model, end, messages, at);
            if (checked.ok) {
              log.info({ event: "gateway.attempt", ...line, attempt, error_class: null, wait_ms: null, decision: "success", latency_ms: elapsed() }, `${model.provider} answered`);
              return { ok: true, value: checked.value, ...meta(model, index, false) };
            }
            // The repair retry: the same provider, once, with its own answer and
            // the validation error. It isn't one of the retries: the provider is fine.
            toRepair = { raw: first.content, error: checked.message };
            log.warn({ event: "gateway.attempt", ...line, attempt, error_class: "schema_fail", wait_ms: 0, decision: "repair", latency_ms: elapsed() }, `${model.provider} answer failed validation: repairing`);
            decision("gateway.repair", { "app.provider": model.provider, "app.attempt": attempt, "app.error_class": "schema_fail" });
            this.metrics.repair(model.provider);
          }

          const repair = loadRepairPrompt();
          const repairStart = Date.now();
          const repairPaced = paced;
          const { res: fixed, checked: rechecked } = await send(
            provider,
            circuit,
            model,
            end,
            [...messages, { role: "assistant", content: toRepair.raw }, { role: "user", content: repair.message.replaceAll("{{error}}", toRepair.error) }],
            at,
            { sha256: repair.sha256, raw: toRepair.raw, error: toRepair.error },
          );
          const repairLine = { event: "gateway.attempt", ...line, attempt, repair: true, wait_ms: null, latency_ms: Date.now() - repairStart - (paced - repairPaced) };
          if (rechecked.ok) {
            log.info({ ...repairLine, error_class: null, decision: "success" }, `${model.provider} answered after repair`);
            return { ok: true, value: rechecked.value, ...meta(model, index, true) };
          }
          // Still broken: a schema_fail. Not a fallback: the provider answered, twice.
          log.warn({ ...repairLine, error_class: "schema_fail", decision: "give_up" }, `${model.provider} answer still invalid after repair`);
          this.metrics.schemaFailure(model.provider);
          return { ok: false, message: rechecked.message, raw: fixed.content, ...meta(model, index, true) };
        } catch (caught) {
          if (!(caught instanceof ProviderError)) {
            // Ours, not the provider's: free a half-open trial so it isn't stuck.
            circuit.release();
            throw caught;
          }
          const err = caught;
          lastError = err;
          const cut = cutByUs.has(err);
          // A cut of ours tells us nothing either way. A 400 means it answered:
          // that ends a half-open trial well.
          const wasOpen = circuit.current() === "open";
          if (cut) circuit.release();
          else if (COUNTS_AGAINST_CIRCUIT.has(err.errorClass)) circuit.failure();
          else circuit.success();
          if (!wasOpen && circuit.current() === "open") {
            decision("gateway.circuit_open", { "app.provider": model.provider, "app.attempt": attempt, "app.error_class": err.errorClass });
          }
          const fail = { event: "gateway.attempt", ...line, attempt, error_class: err.errorClass, latency_ms: elapsed(), ...(cut ? { reason: "cut by the deadline" } : {}) };

          // Not retried: a 400 or a bad key fails the same way every time. The
          // fallback still gets its one try: a retired model or a parameter one
          // provider refuses is exactly what it's there for.
          if (!RETRYABLE.has(err.errorClass) || attempt > g.max_retries || Date.now() >= end()) {
            log.warn({ ...fail, wait_ms: null, decision: next }, `${model.provider} failed (${err.errorClass}): ${next}`);
            break;
          }
          // This failure opened the circuit: waiting to retry would only end in a skip.
          if (circuit.current() === "open") {
            log.warn({ ...fail, wait_ms: null, decision: next, reason: "circuit opened" }, `${model.provider} failed (${err.errorClass}): circuit opened, ${next}`);
            break;
          }

          // Full jitter spreads retries out so many clients don't all come back
          // at the same instant. Retry-After, when sent, wins.
          const wait =
            err.retryAfterS !== undefined ? Math.round(err.retryAfterS * 1000) : Math.round(this.random() * Math.min(g.backoff_cap_ms, g.backoff_base_ms * 2 ** (attempt - 1)));
          if (Date.now() + wait >= end()) {
            log.warn({ ...fail, wait_ms: wait, decision: next, reason: "wait would pass the deadline" }, `${model.provider} failed (${err.errorClass}): ${next}`);
            break;
          }
          log.warn({ ...fail, wait_ms: wait, decision: "retry" }, `${model.provider} failed (${err.errorClass}): retry in ${String(wait)} ms`);
          // An event on the request (OpenTelemetry's way) and a span the length
          // of the wait (what Langfuse draws), so the gap between attempts is explained.
          const waitAttrs = { "app.provider": model.provider, "app.attempt": attempt, "app.error_class": err.errorClass, "app.wait_ms": wait, "app.retry_after": err.retryAfterS !== undefined };
          trace.getActiveSpan()?.addEvent("gateway.retry_wait", waitAttrs);
          const waitSpan = tracer().startSpan("gateway.retry_wait", { attributes: waitAttrs });
          await sleep(wait);
          waitSpan.end();
          retries++;
        }
      }
    }

    // Every provider was skipped without an attempt: fail fast.
    throw lastError ?? new ProviderError("circuit_open", `every provider's circuit is open (${chain.map((m) => m.provider).join(", ")})`, chain[0]?.provider ?? "gateway");
  }
}
