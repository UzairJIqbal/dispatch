// The mock provider: an OpenAI-compatible chat endpoint that lives in the
// process. It is handed to the `openai` client as its `fetch`, so a mock call
// goes through the same client, the same request and the same response
// parsing as a real one. It answers deterministically from the ticket text,
// or fails on purpose the way a real provider does.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Category } from "../categories.js";
import { paths } from "../paths.js";

// The spec's modes, plus 400, 401 and connection so every error class can be
// tested (and drilled) on the mock: a 400 must never be retried, a 401 is auth.
export const MOCK_MODES = ["ok", "429", "500", "hang", "bad_json", "bad_json_once", "slow", "400", "401", "connection"] as const;
export const MockModeSchema = z.enum(MOCK_MODES);
export type MockMode = z.infer<typeof MockModeSchema>;

/**
 * How a mock behaves. Read on every call, so a test can change it between
 * calls. A list of modes is used one per call, the last one repeating.
 */
export type MockOptions = {
  mode?: MockMode | readonly MockMode[];
  /** Sent as Retry-After with a 429. Without it, the 429 has no Retry-After. */
  retryAfterS?: number;
  /** Added latency per call, to make it behave like a slow provider. */
  delayMs?: number;
};

export type MockSetup = { mock: MockOptions; mock_fallback: MockOptions };

const optionalEnv = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
const MockEnvSchema = z.object({
  MOCK_MODE: optionalEnv(MockModeSchema),
  MOCK_FALLBACK_MODE: optionalEnv(MockModeSchema),
  MOCK_RETRY_AFTER: optionalEnv(z.coerce.number().int().nonnegative()),
  MOCK_DELAY_MS: optionalEnv(z.coerce.number().int().nonnegative()),
});

/**
 * Whole-service drills, from the environment. MOCK_MODE breaks the primary
 * mock, MOCK_FALLBACK_MODE the fallback mock; MOCK_RETRY_AFTER goes with a 429
 * on either; MOCK_DELAY_MS slows both.
 */
export function mockSetupFromEnv(env: NodeJS.ProcessEnv = process.env): MockSetup {
  const parsed = MockEnvSchema.safeParse(env);
  if (!parsed.success) {
    const name = String(parsed.error.issues[0]?.path[0] ?? "MOCK_*");
    const hint = name.endsWith("MODE") ? `one of ${MOCK_MODES.join(", ")}` : "a whole number, e.g. 2";
    throw new Error(`${name} is invalid: it must be ${hint}. Set it in .env or on the command line.`);
  }
  const e = parsed.data;
  const shared = {
    ...(e.MOCK_RETRY_AFTER !== undefined ? { retryAfterS: e.MOCK_RETRY_AFTER } : {}),
    ...(e.MOCK_DELAY_MS !== undefined ? { delayMs: e.MOCK_DELAY_MS } : {}),
  };
  return {
    mock: { ...shared, ...(e.MOCK_MODE ? { mode: e.MOCK_MODE } : {}) },
    mock_fallback: { ...shared, ...(e.MOCK_FALLBACK_MODE ? { mode: e.MOCK_FALLBACK_MODE } : {}) },
  };
}

const RequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

// First match wins, so the narrow categories come before the broad ones
// ("cancel my order" is cancel, not order).
const RULES: readonly (readonly [Category, RegExp])[] = [
  ["refund", /refund|money back|reimburs/i],
  ["cancel", /cancel/i],
  ["invoice", /invoice|bill/i],
  ["subscription", /newsletter|subscri/i],
  ["feedback", /feedback|review|complain|opinion/i],
  ["shipping", /address|shipping/i],
  ["delivery", /deliver|arriv|parcel|package/i],
  ["payment", /pay|charged|card/i],
  ["account", /account|password|log ?in|sign ?in|sign ?up|profile|regist/i],
  ["order", /order|purchase|buy/i],
  ["contact", /contact|speak|talk|human|agent|phone|call/i],
];

const HIGH = /charged twice|double charg|fraud|hack|stolen|lost|can'?t (log|sign) ?in|locked|lawyer|legal|sue|late|overdue|never arrived|missing/i;
const LOW_CATEGORIES: readonly Category[] = ["feedback", "subscription", "contact"];

export function mockAnswer(ticket: string): { category: Category; priority: "low" | "medium" | "high"; summary: string } {
  const category = RULES.find(([, re]) => re.test(ticket))?.[0] ?? "contact";
  const priority = HIGH.test(ticket) ? "high" : LOW_CATEGORIES.includes(category) ? "low" : "medium";
  return { category, priority, summary: `Customer needs help with ${category}` };
}

/** The ticket the prompt fenced off; the whole message if there is no fence. */
function extractTicket(user: string): string {
  const match = /<ticket>\n?([\s\S]*?)\n?<\/ticket>/.exec(user);
  return match?.[1] ?? user;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError(signal));
    });
  });
}

/** Never answers. Only the caller giving up (the gateway's timeout) ends it. */
function hang(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(abortError(signal));
    });
  });
}

// `slow` samples real latencies: the uncached calls behind results/baseline.json.
// Without that file (the Docker image doesn't ship results/) it uses 3 s.
let baselineLatencies: number[] | undefined;
const BaselineLatencySchema = z.object({ tickets: z.array(z.object({ latency_ms: z.number().nullable(), cached: z.boolean() })) });
function slowLatencyMs(): number {
  if (!baselineLatencies) {
    baselineLatencies = [];
    if (existsSync(paths.baseline)) {
      const parsed = BaselineLatencySchema.safeParse(JSON.parse(readFileSync(paths.baseline, "utf8")));
      if (parsed.success) baselineLatencies = parsed.data.tickets.flatMap((t) => (t.latency_ms !== null && !t.cached ? [t.latency_ms] : []));
    }
  }
  return baselineLatencies[Math.floor(Math.random() * baselineLatencies.length)] ?? 3000;
}

const failure = (status: number, message: string, headers: Record<string, string> = {}) => Response.json({ error: { message: `mock: ${message}` } }, { status, headers });

export function mockFetch(options: MockOptions = {}) {
  let calls = 0;
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = RequestSchema.safeParse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    if (!body.success) return failure(400, "malformed chat request");

    const modes = options.mode ?? "ok";
    const mode: MockMode = typeof modes === "string" ? modes : (modes[Math.min(calls, modes.length - 1)] ?? "ok");
    calls++;

    await sleep((options.delayMs ?? 0) + (mode === "slow" ? slowLatencyMs() : 0), init?.signal);
    if (mode === "hang") return hang(init?.signal);
    if (mode === "500") return failure(500, "internal error (MOCK_MODE=500)");
    if (mode === "400") return failure(400, "bad request (MOCK_MODE=400)");
    if (mode === "401") return failure(401, "invalid API key (MOCK_MODE=401)");
    // What fetch does when the host can't be reached: the SDK reports it as a connection error.
    if (mode === "connection") throw new TypeError("fetch failed (MOCK_MODE=connection)");
    if (mode === "429") {
      return failure(429, "rate limited (MOCK_MODE=429)", options.retryAfterS !== undefined ? { "retry-after": String(options.retryAfterS) } : {});
    }

    const { messages } = body.data;
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    // A repair request carries the broken answer and the error after the
    // first user message: bad_json_once breaks only the first try.
    const isRepair = messages.length > 2;
    const broken = mode === "bad_json" || (mode === "bad_json_once" && !isRepair);
    const content = broken ? `{"category": "refund", "priority": "hi` : JSON.stringify(mockAnswer(extractTicket(user)));
    const prompt = messages.map((m) => m.content).join("\n");
    return Response.json({
      id: "mock-completion",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.data.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: {
        prompt_tokens: approxTokens(prompt),
        completion_tokens: approxTokens(content),
        total_tokens: approxTokens(prompt) + approxTokens(content),
      },
    });
  };
}
