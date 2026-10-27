import { describe, expect, it } from "vitest";
import { checkSummary, gradeTicket, isDangerousMiss, numbersIn } from "../src/eval/graders.js";
import { compareRuns } from "../src/eval/noise.js";
import { computeMetrics, percentile, rate } from "../src/eval/report.js";
import type { TicketRecord } from "../src/eval/results.js";
import { MAX_BAD_REQUESTS_IN_A_ROW, stopsTheRun } from "../src/eval/run.js";
import { ProviderError } from "../src/gateway/errors.js";

const expected = { category: "refund", priority: "high" } as const;
const answer = (category: "refund" | "order", priority: "low" | "medium" | "high", summary = "Customer wants a refund") => ({
  category,
  priority,
  summary,
});

describe("graders", () => {
  it("grades category and priority separately", () => {
    const g = gradeTicket(expected, "refund please", answer("refund", "medium"));
    expect(g).toMatchObject({ category: true, priority: false, both: false, dangerous_miss: false });
  });
  it("calls a high ticket labelled low a dangerous miss, and nothing else", () => {
    expect(isDangerousMiss(expected, answer("refund", "low"))).toBe(true);
    expect(isDangerousMiss(expected, answer("refund", "medium"))).toBe(false);
    expect(isDangerousMiss({ category: "refund", priority: "low" }, answer("refund", "high"))).toBe(false);
  });
  it("marks no answer wrong everywhere but not dangerous", () => {
    expect(gradeTicket(expected, "x", null)).toEqual({ category: false, priority: false, both: false, dangerous_miss: false, summary: null });
  });
  it("rejects a summary that invents a number", () => {
    expect(checkSummary("Refund for order 1234", "I want a refund for order 1234").numbers_ok).toBe(true);
    expect(checkSummary("Refund for order 9999", "I want a refund for order 1234").numbers_ok).toBe(false);
  });
  it("rejects a summary over 120 characters", () => {
    expect(checkSummary("a".repeat(121), "").length_ok).toBe(false);
    expect(checkSummary("a".repeat(120), "").ok).toBe(true);
  });
  it("finds numbers with separators as one", () => {
    expect(numbersIn("order 12-34 on 3/4 at 10:30, $5.99")).toEqual(["12-34", "3/4", "10:30", "5.99"]);
  });
});

describe("percentile", () => {
  it("returns a value that was actually observed (nearest rank)", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile([7], 99)).toBe(7);
  });
  it("refuses an empty list", () => {
    expect(() => percentile([], 50)).toThrow();
  });
});

function record(over: Partial<TicketRecord> & { id: string }): TicketRecord {
  return {
    source: "bitext",
    expected,
    answer: answer("refund", "high"),
    error: null,
    grade: gradeTicket(expected, "refund", answer("refund", "high")),
    cached: false,
    latency_ms: 1000,
    tokens_in: 100,
    tokens_out: 10,
    ...over,
  };
}

describe("computeMetrics", () => {
  const price = { input: 1, output: 2 };

  it("leaves cached calls out of latency", () => {
    const m = computeMetrics(
      [record({ id: "a", latency_ms: 2000 }), record({ id: "b", latency_ms: 4000 }), record({ id: "c", latency_ms: 1, cached: true })],
      price,
      "2026-10-26",
    );
    expect(m.calls).toEqual({ cached: 1, uncached: 2, failed: 0 });
    expect(m.latency_s).toEqual({ n: 2, p50: 2, p95: 4, p99: 4 });
  });
  it("has no latency when every call was cached", () => {
    expect(computeMetrics([record({ id: "a", cached: true })], price, "2026-10-26").latency_s).toBeNull();
  });
  it("counts a failed call against success and keeps n", () => {
    const failed = record({
      id: "b",
      answer: null,
      error: { class: "timeout", message: "slow" },
      grade: gradeTicket(expected, "", null),
      latency_ms: null,
      tokens_in: 0,
      tokens_out: 0,
    });
    const m = computeMetrics([record({ id: "a" }), failed], price, "2026-10-26");
    expect(m.success).toEqual(rate(1, 2));
    expect(m.both).toEqual(rate(1, 2));
    expect(m.errors).toEqual({ timeout: 1 });
    expect(m.calls.failed).toBe(1);
  });
  it("breaks accuracy down by source with n", () => {
    const m = computeMetrics([record({ id: "a" }), record({ id: "b", source: "messy", grade: gradeTicket(expected, "", null) })], price, "2026-10-26");
    expect(m.by_source).toEqual({ bitext: rate(1, 1), messy: rate(0, 1) });
  });
  it("prices tokens per million", () => {
    const m = computeMetrics([record({ id: "a", tokens_in: 1_000_000, tokens_out: 500_000 })], price, "2026-10-26");
    expect(m.cost_usd.total).toBe(2);
  });
});

describe("compareRuns", () => {
  it("counts tickets whose label changed between two runs", () => {
    const a = [record({ id: "1" }), record({ id: "2" })];
    const b = [record({ id: "1" }), record({ id: "2", answer: answer("refund", "medium"), grade: gradeTicket(expected, "", answer("refund", "medium")) })];
    expect(compareRuns(a, b)).toEqual({ compared: 2, flips: 1, both_flips: 1, flipped_ids: ["2"], failed_ids: [] });
  });
  it("leaves out tickets that failed in either run instead of calling them flips", () => {
    const timedOut = (id: string) =>
      record({ id, answer: null, error: { class: "timeout", message: "slow" }, grade: gradeTicket(expected, "", null), latency_ms: null });
    const a = [record({ id: "1" }), timedOut("2"), record({ id: "3" })];
    const b = [record({ id: "1" }), record({ id: "2" }), timedOut("3")];
    expect(compareRuns(a, b)).toEqual({ compared: 1, flips: 0, both_flips: 0, flipped_ids: [], failed_ids: ["2", "3"] });
  });
  it("refuses runs over different tickets", () => {
    expect(() => compareRuns([record({ id: "1" })], [record({ id: "2" })])).toThrow(/not the second/);
  });
});

describe("stopsTheRun", () => {
  const err = (errorClass: "rate_limit" | "bad_request" | "provider_5xx", status?: number) => new ProviderError(errorClass, "x", "cohere", status);

  it("stops on a rate limit and on errors every ticket would hit", () => {
    expect(stopsTheRun(err("rate_limit", 429), 0)).toBe(true);
    for (const status of [401, 403, 404]) expect(stopsTheRun(err("bad_request", status), 1)).toBe(true);
  });
  it("goes on after a 4xx about one ticket, but not forever", () => {
    expect(stopsTheRun(err("bad_request", 422), 1)).toBe(false);
    expect(stopsTheRun(err("bad_request", 422), MAX_BAD_REQUESTS_IN_A_ROW)).toBe(true);
  });
  it("leaves a 5xx to the record, not the run", () => {
    expect(stopsTheRun(err("provider_5xx", 500), 0)).toBe(false);
  });
});
