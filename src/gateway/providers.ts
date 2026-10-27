// The only file that imports `openai`. Every model call in Dispatch goes
// through a Provider made here. Phase 2 is one plain call: no retries, no
// fallback. Phase 4 builds the gateway's reliability around this.
import OpenAI, { APIConnectionTimeoutError, APIError, RateLimitError } from "openai";
import { loadEnv } from "../env.js";
import { paths, rel } from "../paths.js";
import { loadModelsConfig, type ModelParams, type ModelsConfig, type ProviderName } from "./config.js";
import { ProviderError, type ErrorClass } from "./errors.js";
import { mockFetch, type MockOptions } from "./mock.js";

export type ChatRequest = {
  model: string;
  system: string;
  user: string;
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
  complete(req: ChatRequest): Promise<ChatResponse>;
}

// Generous for one call; Phase 4 replaces it with per-attempt timeouts and a deadline.
const TIMEOUT_MS = 30_000;

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

function classify(err: unknown, provider: ProviderName): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof APIConnectionTimeoutError) {
    return new ProviderError("timeout", `${provider} did not answer within ${String(TIMEOUT_MS / 1000)} s`, provider);
  }
  if (err instanceof APIError) {
    // The SDK types these loosely; narrow them rather than trust them.
    const rawStatus: unknown = err.status;
    const headers: unknown = err.headers;
    const status = typeof rawStatus === "number" ? rawStatus : undefined;
    const retryAfter = Number(headers instanceof Headers ? (headers.get("retry-after") ?? NaN) : NaN);
    const retryAfterS = Number.isFinite(retryAfter) ? retryAfter : undefined;
    let errorClass: ErrorClass;
    if (err instanceof RateLimitError) errorClass = "rate_limit";
    // No status means the connection itself failed: the provider is unreachable, like a 5xx.
    else if (status === undefined || status >= 500) errorClass = "provider_5xx";
    else errorClass = "bad_request";
    const what = status === undefined ? "connection failed" : `HTTP ${String(status)}`;
    return new ProviderError(errorClass, `${provider} ${what}: ${err.message}`, provider, status, retryAfterS);
  }
  return new ProviderError("provider_5xx", `${provider} call failed: ${err instanceof Error ? err.message : String(err)}`, provider);
}

function apiKey(config: ModelsConfig, name: ProviderName): string {
  if (name === "mock") return "mock";
  const { key_env: keyEnv, key_url: keyUrl } = config.providers[name];
  if (!keyEnv) throw new Error(`${rel(paths.models)}: provider ${name} has no key_env.`);
  loadEnv();
  const key = process.env[keyEnv];
  if (!key) {
    throw new Error(
      `${keyEnv} is not set. Get a free key${keyUrl ? ` at ${keyUrl}` : ""} and add \`${keyEnv}=...\` to .env in the repo root.\n` +
        "(Or run on the mock with `--provider mock`, which needs no key.)",
    );
  }
  return key;
}

/** Makes a provider. Fails here, before any call, if its key is missing. */
export function createProvider(name: ProviderName, mock: MockOptions = {}, config = loadModelsConfig()): Provider {
  const p = config.providers[name];
  const client = new OpenAI({
    baseURL: p.base_url,
    apiKey: apiKey(config, name),
    // The SDK retries twice by default. Retries are the gateway's job, and
    // they don't exist yet, so: none.
    maxRetries: 0,
    timeout: TIMEOUT_MS,
    // The mock speaks the same HTTP API in-process, so it runs through the
    // exact client code the real providers do.
    ...(name === "mock" ? { fetch: mockFetch(mock) } : {}),
  });
  const pacer = p.rpm ? new Pacer(p.rpm) : undefined;

  return {
    name,
    async complete(req) {
      await pacer?.wait();
      const started = performance.now();
      try {
        const res = await client.chat.completions.create({
          model: req.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          temperature: req.temperature,
          // max_completion_tokens is the new name, but not every OpenAI-compatible
          // API accepts it yet. Every provider accepts this one.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          max_tokens: req.maxTokens,
          response_format: { type: "json_object" },
          ...(req.params.reasoning_effort ? { reasoning_effort: req.params.reasoning_effort } : {}),
        });
        return {
          content: res.choices[0]?.message.content ?? "",
          tokensIn: res.usage?.prompt_tokens ?? 0,
          tokensOut: res.usage?.completion_tokens ?? 0,
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (err) {
        throw classify(err, name);
      }
    },
  };
}
