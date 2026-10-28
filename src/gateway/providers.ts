// The only file that imports `openai`. Every model call in Dispatch goes
// through a Provider made here, and every Provider is driven by the gateway
// (gateway.ts), which owns retries, fallback, timeouts and the circuit breaker.
// A Provider makes exactly one attempt and classifies how it failed.
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { loadEnv } from "../env.js";
import { paths, rel } from "../paths.js";
import { isMock, loadModelsConfig, type ModelParams, type ModelsConfig, type ProviderName } from "./config.js";
import { ProviderError, type ErrorClass } from "./errors.js";
import { mockFetch, type MockOptions } from "./mock.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatRequest = {
  model: string;
  messages: readonly ChatMessage[];
  temperature: number;
  maxTokens: number;
  params: ModelParams;
};

export type ChatResponse = {
  content: string;
  tokensIn: number;
  tokensOut: number;
  /** Time of the call itself, not of waiting for a free-tier slot. */
  latencyMs: number;
};

export interface Provider {
  readonly name: ProviderName;
  /** Waits for a free-tier slot. The gateway calls it before each attempt and doesn't count the wait against the deadline. */
  pace(): Promise<void>;
  /** One attempt. Aborting `signal` cancels it; it then fails as `timeout`. */
  complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
}

// Spaces calls to stay under a free-tier requests-per-minute limit. This is
// not a retry: a 429 still fails the call. The 10% margin covers the provider
// counting its window slightly differently from us.
export class Pacer {
  private next = 0;
  private readonly intervalMs: number;
  constructor(rpm: number) {
    this.intervalMs = Math.ceil((60_000 / rpm) * 1.1);
  }
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
}

/** Retry-After is either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - now) / 1000);
}

function classifyStatus(status: number): ErrorClass {
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  // A wrong or revoked key fails the same way every time: never retried.
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "provider_5xx";
  return "bad_request";
}

export function classify(err: unknown, provider: ProviderName, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  // The gateway gave up on this attempt (its timeout or the deadline).
  if (err instanceof APIUserAbortError || signal?.aborted) return new ProviderError("timeout", `${provider} did not answer in time`, provider);
  if (err instanceof APIConnectionTimeoutError) return new ProviderError("timeout", `${provider} did not answer in time`, provider);
  if (err instanceof APIConnectionError) return new ProviderError("connection", `${provider} connection failed: ${err.message}`, provider);
  if (err instanceof APIError) {
    // The SDK types these loosely; narrow them rather than trust them.
    const rawStatus: unknown = err.status;
    const headers: unknown = err.headers;
    if (typeof rawStatus !== "number") return new ProviderError("connection", `${provider} connection failed: ${err.message}`, provider);
    const retryAfterS = headers instanceof Headers ? parseRetryAfter(headers.get("retry-after")) : undefined;
    // Gemini says a wrong key with a 400 ("Please pass a valid API key"), not a
    // 401: still auth, so it counts against the circuit and is logged as what it is.
    const body = `${err.message} ${JSON.stringify(err.error ?? null)}`;
    const errorClass = rawStatus === 400 && /valid API key|API_KEY_INVALID/i.test(body) ? "auth" : classifyStatus(rawStatus);
    return new ProviderError(errorClass, `${provider} HTTP ${String(rawStatus)}: ${err.message}`, provider, rawStatus, retryAfterS);
  }
  return new ProviderError("provider_5xx", `${provider} call failed: ${err instanceof Error ? err.message : String(err)}`, provider);
}

/** Says which variable is missing and where to put it, without reading .env into a log. */
export function missingKey(config: ModelsConfig, name: ProviderName): string | undefined {
  if (isMock(name)) return undefined;
  const { key_env: keyEnv, key_url: keyUrl } = config.providers[name];
  if (!keyEnv) return `${rel(paths.models)}: provider ${name} has no key_env.`;
  loadEnv();
  if (process.env[keyEnv]) return undefined;
  return (
    `${keyEnv} is not set. Get a free key${keyUrl ? ` at ${keyUrl}` : ""} and add \`${keyEnv}=...\` to .env in the repo root.\n` +
    "(Or run on the mock with `--provider mock`, which needs no key.)"
  );
}

function apiKey(config: ModelsConfig, name: ProviderName): string {
  if (isMock(name)) return "mock";
  const problem = missingKey(config, name);
  if (problem) throw new Error(problem);
  const keyEnv = config.providers[name].key_env;
  return keyEnv ? (process.env[keyEnv] ?? "") : "";
}

/** Makes a provider. Fails here, before any call, if its key is missing. */
export function createProvider(name: ProviderName, mock: MockOptions = {}, config = loadModelsConfig()): Provider {
  const p = config.providers[name];
  const client = new OpenAI({
    baseURL: p.base_url,
    apiKey: apiKey(config, name),
    // The SDK retries twice by default. Retries are the gateway's job: none here.
    maxRetries: 0,
    // A safety net only. The gateway cancels each attempt itself, sooner.
    timeout: config.gateway.deadline_ms + 5_000,
    // The mocks speak the same HTTP API in-process, so they run through the
    // exact client code the real providers do.
    ...(isMock(name) ? { fetch: mockFetch(mock) } : {}),
  });
  const pacer = p.rpm ? new Pacer(p.rpm) : undefined;

  return {
    name,
    async pace() {
      await pacer?.wait();
    },
    async complete(req, signal) {
      const started = performance.now();
      try {
        const res = await client.chat.completions.create(
          {
            model: req.model,
            messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
            temperature: req.temperature,
            // max_completion_tokens is the new name, but not every OpenAI-compatible
            // API accepts it yet. Every provider accepts this one.
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            max_tokens: req.maxTokens,
            response_format: { type: "json_object" },
            ...(req.params.reasoning_effort ? { reasoning_effort: req.params.reasoning_effort } : {}),
          },
          { signal },
        );
        return {
          content: res.choices[0]?.message.content ?? "",
          tokensIn: res.usage?.prompt_tokens ?? 0,
          tokensOut: res.usage?.completion_tokens ?? 0,
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (err) {
        throw classify(err, name, signal);
      }
    },
  };
}
