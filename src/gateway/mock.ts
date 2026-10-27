// The mock provider: an OpenAI-compatible chat endpoint that lives in the
// process. It is handed to the `openai` client as its `fetch`, so a mock call
// goes through the same client, the same request and the same response
// parsing as a real one. It answers deterministically from the ticket text.
// Phase 4 teaches it to fail (429, 500, hang, broken JSON).
import { z } from "zod";
import type { Category } from "../categories.js";

export type MockOptions = {
  /** Added latency per call, to make it behave like a slow provider. */
  delayMs?: number;
};

/** MOCK_DELAY_MS from the environment, for commands run by hand. */
export function mockOptionsFromEnv(): MockOptions {
  const delay = z.coerce.number().int().nonnegative().optional().safeParse(process.env.MOCK_DELAY_MS);
  if (!delay.success) throw new Error("MOCK_DELAY_MS must be a whole number of milliseconds, e.g. MOCK_DELAY_MS=300.");
  return delay.data === undefined ? {} : { delayMs: delay.data };
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

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    });
  });
}

export function mockFetch(options: MockOptions = {}) {
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = RequestSchema.safeParse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    if (!body.success) {
      return Response.json({ error: { message: "mock: malformed chat request" } }, { status: 400 });
    }
    await sleep(options.delayMs ?? 0, init?.signal);

    const user = body.data.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const content = JSON.stringify(mockAnswer(extractTicket(user)));
    const prompt = body.data.messages.map((m) => m.content).join("\n");
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
