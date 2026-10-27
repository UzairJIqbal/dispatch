// The gateway: the one way to call a model. It owns everything that keeps a
// request alive when a provider isn't: a timeout per attempt and a deadline
// per request, retries with backoff on the errors worth retrying, a circuit
// breaker per provider, the fallback provider, and one repair retry for an
// answer that fails validation.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pino, type Logger } from "pino";
import { parse } from "yaml";
import { z } from "zod";
import { paths, rel } from "../paths.js";
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

  constructor(opts: GatewayOptions = {}) {
    this.config = opts.config ?? loadModelsConfig();
    const fromEnv = opts.mocks?.mock && opts.mocks.mock_fallback ? undefined : mockSetupFromEnv();
    this.mocks = { mock: opts.mocks?.mock ?? fromEnv?.mock ?? {}, mock_fallback: opts.mocks?.mock_fallback ?? fromEnv?.mock_fallback ?? {} };
    this.log = opts.log ?? pino({ level: "silent" });
    this.random = opts.random ?? Math.random;
  }

  /** The providers a call may use, in order. */
  chain(alias: string, provider?: ProviderName): ResolvedModel[] {
    return resolveChain(this.config, alias, provider);
  }

  /** Makes every provider in the chain now, so a missing key fails before the first request. */
  prepare(alias: string, provider?: ProviderName): void {
    for (const m of this.chain(alias, provider)) this.provider(m.provider);
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

    // One call to one provider: from the cache, or a real attempt under the
    // attempt timeout and what's left of the deadline.
    const send = async (
      provider: Provider,
      model: ResolvedModel,
      end: () => number,
      messages: ChatMessage[],
      repair?: CacheKeyParts["repair"],
    ): Promise<ChatResponse> => {
      calls++;
      const key = req.cache && cacheKey({ ...req.cache.parts, provider: model.provider, model: model.model, params: model.params, ...(repair ? { repair } : {}) });
      const hit = key && !req.cache?.refresh ? req.cache?.store.get(key) : undefined;
      if (hit) {
        cachedCalls++;
        cachedLatency += hit.latencyMs;
        return hit;
      }

      const waitStart = Date.now();
      await provider.pace();
      const waited = Date.now() - waitStart;
      paced += waited;
      deadline += waited;

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error("attempt timed out"));
      }, Math.max(0, Math.min(g.attempt_timeout_ms, end() - Date.now())));
      let res: ChatResponse;
      try {
        res = await provider.complete({ model: model.model, messages, temperature: req.temperature, maxTokens: req.maxTokens, params: model.params }, controller.signal);
      } catch (err) {
        // Only the provider call is classified: a fault of ours (the cache, a
        // prompt file) must never read as the provider failing.
        throw classify(err, model.provider, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      // Stored as soon as it arrives, so an eval stopped by a rate limit picks up here.
      if (key) req.cache?.store.set(key, res);
      return res;
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

    // A hung primary must not eat the whole deadline: it gets the deadline
    // minus one attempt's worth, which is kept for the fallback.
    const reserve = Math.min(g.attempt_timeout_ms, g.deadline_ms / 2);
    // Repair once per request, even if the repair call itself fails and is retried.
    let repairTried = false;

    for (const [index, model] of chain.entries()) {
      const isLast = index === chain.length - 1;
      const next: Decision = isLast ? "give_up" : "fallback";
      const end = () => (isLast ? deadline : deadline - reserve);
      const provider = this.provider(model.provider);
      const circuit = this.circuit(model.provider);
      const line = { provider: model.provider, model: model.model };

      for (let attempt = 1; attempt <= g.max_retries + 1; attempt++) {
        if (!circuit.allow()) {
          // Open circuit: skipped at once, no timeout to wait out.
          log.warn({ event: "gateway.skip", ...line, attempt, error_class: "circuit_open", wait_ms: null, decision: next }, `${model.provider} skipped: circuit open`);
          break;
        }
        if (end() - Date.now() <= 0) {
          // Out of this provider's time. Not a failure of the provider: nothing was sent.
          lastError ??= new ProviderError("timeout", `no time left before the ${String(g.deadline_ms / 1000)} s deadline`, model.provider);
          break;
        }
        const attemptStart = Date.now();
        const pacedBefore = paced;
        const elapsed = () => Date.now() - attemptStart - (paced - pacedBefore);
        try {
          const messages: ChatMessage[] = [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ];
          const first = await send(provider, model, end, messages);
          circuit.success();
          tokensIn += first.tokensIn;
          tokensOut += first.tokensOut;
          const checked = req.validate(first.content);
          if (checked.ok) {
            log.info({ event: "gateway.attempt", ...line, attempt, error_class: null, wait_ms: null, decision: "success", latency_ms: elapsed() }, `${model.provider} answered`);
            return { ok: true, value: checked.value, ...meta(model, index, false) };
          }

          if (repairTried) {
            log.warn({ event: "gateway.attempt", ...line, attempt, error_class: "schema_fail", wait_ms: null, decision: "give_up", latency_ms: elapsed() }, `${model.provider} answer invalid, already repaired once`);
            return { ok: false, message: checked.message, raw: first.content, ...meta(model, index, true) };
          }
          // The repair retry: the same provider, once, with its own answer and
          // the validation error. It isn't one of the retries: the provider is fine.
          repairTried = true;
          log.warn({ event: "gateway.attempt", ...line, attempt, error_class: "schema_fail", wait_ms: 0, decision: "repair", latency_ms: elapsed() }, `${model.provider} answer failed validation: repairing`);
          const repair = loadRepairPrompt();
          const repairStart = Date.now();
          const repairPaced = paced;
          const fixed = await send(provider, model, end, [...messages, { role: "assistant", content: first.content }, { role: "user", content: repair.message.replaceAll("{{error}}", checked.message) }], {
            sha256: repair.sha256,
            raw: first.content,
            error: checked.message,
          });
          circuit.success();
          tokensIn += fixed.tokensIn;
          tokensOut += fixed.tokensOut;
          const rechecked = req.validate(fixed.content);
          const repairLine = { event: "gateway.attempt", ...line, attempt, repair: true, wait_ms: null, latency_ms: Date.now() - repairStart - (paced - repairPaced) };
          if (rechecked.ok) {
            log.info({ ...repairLine, error_class: null, decision: "success" }, `${model.provider} answered after repair`);
            return { ok: true, value: rechecked.value, ...meta(model, index, true) };
          }
          // Still broken: a schema_fail. Not a fallback: the provider answered, twice.
          log.warn({ ...repairLine, error_class: "schema_fail", decision: "give_up" }, `${model.provider} answer still invalid after repair`);
          return { ok: false, message: rechecked.message, raw: fixed.content, ...meta(model, index, true) };
        } catch (caught) {
          if (!(caught instanceof ProviderError)) throw caught;
          const err = caught;
          lastError = err;
          if (COUNTS_AGAINST_CIRCUIT.has(err.errorClass)) circuit.failure();
          // It answered: that ends a half-open trial well, and isn't a failure.
          else circuit.success();
          const fail = { event: "gateway.attempt", ...line, attempt, error_class: err.errorClass, latency_ms: elapsed() };

          // A 400 is about the request, so another provider would refuse it
          // too: called exactly once, no retry and no fallback.
          if (err.errorClass === "bad_request") {
            log.warn({ ...fail, wait_ms: null, decision: "give_up" }, `${model.provider} failed (bad_request): give_up`);
            throw err;
          }
          if (!RETRYABLE.has(err.errorClass) || attempt > g.max_retries || Date.now() >= end()) {
            log.warn({ ...fail, wait_ms: null, decision: next }, `${model.provider} failed (${err.errorClass}): ${next}`);
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
          await sleep(wait);
          retries++;
        }
      }
    }

    // Every provider was skipped without an attempt: fail fast.
    throw lastError ?? new ProviderError("circuit_open", `every provider's circuit is open (${chain.map((m) => m.provider).join(", ")})`, chain[0]?.provider ?? "gateway");
  }
}
