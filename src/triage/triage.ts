import type { Logger } from "pino";
import { z } from "zod";
import { gitSha } from "../env.js";
import type { ResponseCache } from "../gateway/cache.js";
import type { ProviderName } from "../gateway/config.js";
import { ProviderError } from "../gateway/errors.js";
import { Gateway } from "../gateway/gateway.js";
import { MAX_TICKET_CHARS } from "../golden/schema.js";
import { loadPrompt, renderPrompt } from "./prompt.js";
import { TriageAnswerSchema, type TriageAnswer } from "./schema.js";

export type TriageMeta = {
  prompt_version: string;
  provider: ProviderName;
  model: string;
  git_sha: string;
  /** Answered by the fallback provider. */
  fallback: boolean;
  retries: number;
  /** The first answer failed validation and was repaired (or failed again). */
  repaired: boolean;
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
  /** Starts on that provider's model instead of the prompt's alias. */
  provider?: ProviderName;
  /** Eval-only response cache. */
  cache?: ResponseCache;
  /** With a cache: skip reading it but still store the fresh answer. */
  refresh?: boolean;
  gateway?: Gateway;
  /** The request's logger, for the gateway's attempt lines. None: silent. */
  log?: Logger;
};

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
 * through here, and it goes through the gateway. An answer still broken after
 * its repair comes back as `schema_fail`; a request no provider answered
 * throws a typed ProviderError.
 */
export async function triage(text: string, version: string, opts: TriageOptions = {}): Promise<TriageResult> {
  const prompt = loadPrompt(version);
  if (text.length > MAX_TICKET_CHARS) {
    throw new ProviderError("bad_request", `ticket is ${String(text.length)} characters; the limit is ${String(MAX_TICKET_CHARS)}`, "gateway");
  }
  const gateway = opts.gateway ?? (defaultGateway ??= new Gateway());
  const { system, user } = renderPrompt(prompt, text);

  const r = await gateway.call({
    alias: prompt.model,
    ...(opts.provider ? { provider: opts.provider } : {}),
    system,
    user,
    temperature: prompt.temperature,
    maxTokens: prompt.max_tokens,
    validate: (raw) => {
      const p = parseAnswer(raw);
      return p.ok ? { ok: true, value: p.answer } : p;
    },
    ...(opts.cache
      ? {
          cache: {
            store: opts.cache,
            refresh: opts.refresh ?? false,
            parts: { promptVersion: prompt.version, promptSha256: prompt.sha256, temperature: prompt.temperature, maxTokens: prompt.max_tokens, text },
          },
        }
      : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });

  const meta: TriageMeta = {
    prompt_version: prompt.version,
    provider: r.provider,
    model: r.model,
    git_sha: gitSha(),
    fallback: r.fallback,
    retries: r.retries,
    repaired: r.repaired,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
    latency_ms: r.latencyMs,
    cached: r.cached,
  };
  if (r.ok) return { ok: true, answer: r.value, ...meta };
  return { ok: false, error: { class: "schema_fail", message: r.message }, raw: r.raw, ...meta };
}

/** The cache key of a ticket's first try on the primary: how the eval plan counts what's already cached. */
export function firstTryKeyParts(text: string, version: string) {
  const prompt = loadPrompt(version);
  return { prompt, parts: { promptVersion: prompt.version, promptSha256: prompt.sha256, temperature: prompt.temperature, maxTokens: prompt.max_tokens, text } };
}
