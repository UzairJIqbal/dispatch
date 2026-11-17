import { describe, expect, it } from "vitest";
import { costFor, costModel, formatCost, inputSplit } from "../src/cost/cost.js";
import type { TicketRecord } from "../src/eval/results.js";

const grade = { category: true, priority: true, both: true, dangerous_miss: false, summary: null };
const answer = { category: "order", priority: "low", summary: "x" } as const;

function record(over: Partial<TicketRecord>): TicketRecord {
  return {
    id: "t",
    source: "bitext",
    expected: { category: "order", priority: "low" },
    answer,
    error: null,
    grade,
    cached: false,
    latency_ms: 100,
    tokens_in: 1000,
    tokens_out: 100,
    ...over,
  };
}

const price = { input: 1, output: 10 }; // $ per million: 1,000 in + 100 out = $0.002
const gemini = { provider: "gemini", model: "g", price } as const;

describe("cost model", () => {
  it("prices a request from tokens and list prices", () => {
    const c = costFor([record({})], gemini, false);
    expect(c.perRequest).toBeCloseTo(0.002);
    expect(c.per1000Successes).toBeCloseTo(2);
    expect(c.inputShare).toBeCloseTo(0.5);
  });

  it("charges failed requests that used tokens, but divides by successes only", () => {
    const failed = record({ answer: null, error: { class: "schema_fail", message: "bad" } });
    const c = costFor([record({}), failed], gemini, false);
    expect(c.requests).toBe(2);
    expect(c.successes).toBe(1);
    // $0.004 spent, one success: $4 per 1,000 successes, not $2.
    expect(c.per1000Successes).toBeCloseTo(4);
  });

  it("leaves out requests that never reached a provider", () => {
    const never = record({ answer: null, latency_ms: null, tokens_in: 0, tokens_out: 0, error: { class: "circuit_open", message: "open" } });
    expect(costFor([record({}), never], gemini, false).requests).toBe(1);
  });

  it("projects 10,000 tickets a day over 30 days", () => {
    expect(costFor([record({})], gemini, false).monthly).toBeCloseTo(0.002 * 10_000 * 30);
  });

  it("prices the fallback on the primary's tokens, marked as assumed, when it has no run", () => {
    const [p, f] = costModel([record({}), record({})], [gemini, { provider: "cohere", model: "c", price: { input: 2, output: 20 } }]);
    expect(p?.assumedTokens).toBe(false);
    expect(f?.assumedTokens).toBe(true);
    expect(f?.perRequest).toBeCloseTo(0.004);
  });

  it("splits the input into the fixed prompt and the ticket", () => {
    const s = inputSplit(660, 80); // 80 characters is about 20 tokens
    expect(s.ticket).toBe(20);
    expect(s.fixedShare).toBeCloseTo(640 / 660);
  });

  it("prints the date, the $0 bill and the per-1,000 line", () => {
    const text = formatCost({ runLabel: "run", priceDate: "2026-10-27", models: costModel([record({})], [gemini]) });
    expect(text).toContain("2026-10-27");
    expect(text).toContain("The real bill was $0");
    expect(text).toContain("cost per 1,000 successful requests");
  });
});
