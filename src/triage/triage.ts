import { z } from "zod";
import { gitSha } from "../env.js";
import { loadModelsConfig, resolveModel, type ProviderName } from "../gateway/config.js";
import { ProviderError } from "../gateway/errors.js";
import { mockOptionsFromEnv, type MockOptions } from "../gateway/mock.js";
import { createProvider, type ChatResponse, type Provider } from "../gateway/providers.js";
import { MAX_TICKET_CHARS } from "../golden/schema.js";
import { cacheKey, type ResponseCache } from "./cache.js";
import { loadPrompt, renderPrompt } from "./prompt.js";
import { TriageAnswerSchema, type TriageAnswer } from "./schema.js";

export type TriageMeta = {
  prompt_version: string;
  provider: ProviderName;
  model: string;
  git_sha: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  /** Served from the eval cache: its latency is the original call's and must not be counted again. */
  cached: boolean;
};

export type TriageResult =
  | ({ ok: true; answer: TriageAnswer } & TriageMeta)
  | ({ ok: false; error: { class: "schema_fail"; message: string }; raw: string } & TriageMeta);

export type TriageOptions = {
  /** Overrides the prompt's model alias with that provider's model. */
  provider?: ProviderName;
  /** Eval-only response cache. */
  cache?: ResponseCache;
  /** With a cache: skip reading it but still store the fresh answer. */
  refresh?: boolean;
  gateway?: Gateway;
};

/** Holds one provider of each kind, so their free-tier pacing is shared by every call in the process. */
export class Gateway {
  private readonly providers = new Map<ProviderName, Provider>();
  constructor(private readonly mock: MockOptions = mockOptionsFromEnv()) {}
  provider(name: ProviderName): Provider {
    let p = this.providers.get(name);
    if (!p) {
      p = createProvider(name, this.mock);
      this.providers.set(name, p);
    }
    return p;
  }
}

let defaultGateway: Gateway | undefined;

/** Parses the model's text into an answer, or says why it isn't one. Never throws. */
export function parseAnswer(raw: string): { ok: true; answer: TriageAnswer } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Not the parser's message: it quotes the text, and that text can echo the ticket.
    return { ok: false, message: raw.trim() === "" ? "empty answer" : "answer is not valid JSON" };
  }
  const parsed = TriageAnswerSchema.safeParse(json);
  if (!parsed.success) return { ok: false, message: z.prettifyError(parsed.error) };
  return { ok: true, answer: parsed.data };
}

/**
 * The one triage call. The service, the eval and the load test all come
 * through here. A broken answer comes back as `schema_fail`; a failed call
 * (rate limit, timeout, 5xx, 4xx) throws a typed ProviderError.
 */
export async function triage(text: string, version: string, opts: TriageOptions = {}): Promise<TriageResult> {
  const { prompt, resolved, system, user, key } = prepareCall(text, version, opts.provider);
  if (text.length > MAX_TICKET_CHARS) {
    throw new ProviderError("bad_request", `ticket is ${String(text.length)} characters; the limit is ${String(MAX_TICKET_CHARS)}`, resolved.provider);
  }
  const gateway = opts.gateway ?? (defaultGateway ??= new Gateway());
  const provider = gateway.provider(resolved.provider);

  let res: ChatResponse | undefined = opts.refresh ? undefined : opts.cache?.get(key);
  const cached = res !== undefined;
  if (!res) {
    res = await provider.complete({
      model: resolved.model,
      system,
      user,
      temperature: prompt.temperature,
      maxTokens: prompt.max_tokens,
      params: resolved.params,
    });
    // Stored as soon as it arrives, so a run stopped by a rate limit picks up here.
    opts.cache?.set(key, res);
  }

  const meta: TriageMeta = {
    prompt_version: prompt.version,
    provider: resolved.provider,
    model: resolved.model,
    git_sha: gitSha(),
    tokens_in: res.tokensIn,
    tokens_out: res.tokensOut,
    latency_ms: res.latencyMs,
    cached,
  };
  const parsed = parseAnswer(res.content);
  if (parsed.ok) return { ok: true, answer: parsed.answer, ...meta };
  return { ok: false, error: { class: "schema_fail", message: parsed.message }, raw: res.content, ...meta };
}

/** Everything about a call that is decided before it's made: the prompt, the model, and the cache key. */
export function prepareCall(text: string, version: string, provider?: ProviderName) {
  const prompt = loadPrompt(version);
  const resolved = resolveModel(loadModelsConfig(), prompt.model, provider);
  const { system, user } = renderPrompt(prompt, text);
  const key = cacheKey({
    provider: resolved.provider,
    model: resolved.model,
    promptVersion: prompt.version,
    promptSha256: prompt.sha256,
    temperature: prompt.temperature,
    maxTokens: prompt.max_tokens,
    params: resolved.params,
    text,
  });
  return { prompt, resolved, system, user, key };
}
