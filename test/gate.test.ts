import { describe, expect, it } from "vitest";
import { baselineProblems, formatGate, GATE_COMMENT_MARKER, parseGateRules, pickNoise, runGate, type GateRules } from "../src/eval/gate.js";
import { gradeTicket } from "../src/eval/graders.js";
import { computeMetrics } from "../src/eval/report.js";
import type { Noise, ResultsFile, TicketRecord } from "../src/eval/results.js";
import { checkGoldenChange } from "../src/golden/check.js";
import { GOLDEN_VERSION, serializeGolden } from "../src/golden/golden.js";
import type { GoldenRow } from "../src/golden/schema.js";
import { splitFor } from "../src/golden/split.js";

const rules: GateRules = {
  both_correct: { max_drop_pts: 2 },
  dangerous_misses: { max_new: 0 },
  schema_valid: { max_drop_pts: 2 },
  latency_p95: { max_rise_pct: 15 },
  cost_per_request: { max_rise_pct: 15 },
};

const expected = { category: "refund", priority: "high" } as const;
type Priority = "low" | "medium" | "high";

/** One ticket: right, or answered with the given priority (low = a dangerous miss). */
function ticket(id: string, priority: Priority = "high", over: Partial<TicketRecord> = {}): TicketRecord {
  const answer = { category: "refund", priority, summary: "Customer wants a refund" } as const;
  return {
    id,
    source: "bitext",
    expected,
    answer,
    error: null,
    grade: gradeTicket(expected, "refund", answer),
    cached: false,
    latency_ms: 1000,
    tokens_in: 100,
    tokens_out: 10,
    ...over,
  };
}

function results(tickets: TicketRecord[], over: Partial<ResultsFile["run"]> = {}): ResultsFile {
  return {
    run: {
      id: "r",
      started_at: "2026-10-31T00:00:00.000Z",
      finished_at: "2026-10-31T00:01:00.000Z",
      split: "test",
      prompt_version: "v2",
      provider: "gemini",
      model: "m",
      dataset_version: "v2",
      git_sha: "abc",
      cache: "used",
      ...over,
    },
    metrics: computeMetrics(tickets, { input: 1, output: 2 }, "2026-10-27"),
    tickets,
  };
}

// 100 tickets, so one ticket is one point.
const ids = Array.from({ length: 100 }, (_, i) => `t${String(i)}`);
const baseTickets = ids.map((id, i) => ticket(id, i < 10 ? "medium" : "high"));
const baseline = results(baseTickets);
const withChanges = (change: (t: TicketRecord, i: number) => TicketRecord) => results(baseTickets.map(change));
const verdict = (r: ReturnType<typeof runGate>, rule: keyof GateRules) => r.rules.find((x) => x.rule === rule)?.verdict;

describe("runGate", () => {
  it("passes the baseline against itself", () => {
    const r = runGate(baseline, baseline, rules, undefined);
    expect(r.ok).toBe(true);
    expect(r.rules.map((x) => x.verdict)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
  });

  it("allows a 2-point drop and fails a 3-point one", () => {
    const drop = (k: number) => withChanges((t, i) => (i >= 10 && i < 10 + k ? ticket(t.id, "medium") : t));
    expect(verdict(runGate(baseline, drop(2), rules, undefined), "both_correct")).toBe("pass");
    expect(verdict(runGate(baseline, drop(3), rules, undefined), "both_correct")).toBe("fail");
  });

  it("uses the noise floor when it is larger than the fixed points", () => {
    const drop3 = withChanges((t, i) => (i >= 10 && i < 13 ? ticket(t.id, "medium") : t));
    const noise: Noise = {
      prompt_version: "v2",
      provider: "gemini",
      model: "m",
      dataset_version: "v2",
      split: "test",
      measured_at: "2026-10-30T00:00:00.000Z",
      git_sha: "abc",
      n: 100,
      compared: 100,
      flips: 4,
      both_flips: 4,
      flipped_ids: [],
      failed_ids: [],
      both_correct: [
        { pct: 90, k: 90, n: 100 },
        { pct: 90, k: 90, n: 100 },
      ],
    };
    const r = runGate(baseline, drop3, rules, noise);
    expect(verdict(r, "both_correct")).toBe("pass");
    expect(r.rules[0]?.limit).toMatch(/noise floor/);
  });

  it("fails one new dangerous miss, even when another is fixed", () => {
    const base = withChanges((t, i) => (i === 50 ? ticket(t.id, "low") : t));
    const swapped = withChanges((t, i) => (i === 51 ? ticket(t.id, "low") : t));
    const r = runGate(base, swapped, rules, undefined);
    expect(base.metrics.dangerous_misses).toBe(swapped.metrics.dangerous_misses);
    expect(verdict(r, "dangerous_misses")).toBe("fail");
    expect(r.rules[1]?.change).toBe("1 new, 1 fixed");
  });

  it("fails a 3-point schema-valid drop", () => {
    const repaired = withChanges((t, i) => (i < 3 ? { ...t, repaired: true } : t));
    expect(verdict(runGate(baseline, repaired, rules, undefined), "schema_valid")).toBe("fail");
  });

  it("allows a 15% p95 rise and fails a 16% one", () => {
    const slower = (ms: number) => withChanges((t) => ({ ...t, latency_ms: ms }));
    expect(verdict(runGate(baseline, slower(1150), rules, undefined), "latency_p95")).toBe("pass");
    expect(verdict(runGate(baseline, slower(1160), rules, undefined), "latency_p95")).toBe("fail");
  });

  it("says latency is not measured when every call was cached, and doesn't fail on it", () => {
    const cached = withChanges((t) => ({ ...t, cached: true }));
    const r = runGate(baseline, cached, rules, undefined);
    expect(verdict(r, "latency_p95")).toBe("not measured");
    expect(r.ok).toBe(true);
  });

  it("fails a cost rise over 15%", () => {
    const wordier = withChanges((t) => ({ ...t, tokens_in: 120 }));
    expect(verdict(runGate(baseline, wordier, rules, undefined), "cost_per_request")).toBe("fail");
  });

  it("refuses to compare runs graded on different tickets", () => {
    const fewer = results(baseTickets.slice(1));
    const r = runGate(baseline, fewer, rules, undefined);
    expect(r.ok).toBe(false);
    expect(r.rules).toEqual([]);
    expect(r.mismatch.join(" ")).toMatch(/1 of the baseline's missing/);
  });

  it("refuses a relabelled ticket, a dev run and another golden version", () => {
    const relabelled = withChanges((t, i) => (i === 0 ? { ...t, expected: { category: "refund", priority: "low" } } : t));
    expect(runGate(baseline, relabelled, rules, undefined).mismatch.join(" ")).toMatch(/1 with different expected labels/);
    expect(runGate(baseline, results(baseTickets, { split: "dev" }), rules, undefined).ok).toBe(false);
    expect(runGate(baseline, results(baseTickets, { dataset_version: "v3" }), rules, undefined).ok).toBe(false);
  });
});

describe("pickNoise", () => {
  const noise = (prompt_version: string) => ({ prompt_version, provider: "gemini", model: "m", dataset_version: "v2", compared: 74 }) as Noise;
  it("only takes a noise floor measured on the baseline's setup", () => {
    expect(pickNoise(baseline, [undefined, noise("v1")])).toBeUndefined();
    expect(pickNoise(baseline, [noise("v1"), noise("v2")])?.prompt_version).toBe("v2");
  });
});

describe("parseGateRules", () => {
  it("refuses an unknown or missing rule", () => {
    expect(() => parseGateRules("both_correct: { max_drop_pts: 2 }", "gate.yaml")).toThrow(/gate.yaml is invalid/);
    expect(() => parseGateRules("both_correct: { max_drop_pts: -1 }", "gate.yaml")).toThrow();
  });
});

describe("baselineProblems", () => {
  it("accepts a clean uncached test run", () => {
    expect(baselineProblems(baseline)).toEqual([]);
  });
  it("refuses cached answers, failures and fallbacks", () => {
    const messy = withChanges((t, i) =>
      i === 0 ? { ...t, cached: true } : i === 1 ? { ...t, answer: null, latency_ms: null, error: { class: "timeout", message: "x" } } : i === 2 ? { ...t, fallback: true } : t,
    );
    expect(baselineProblems(messy)).toHaveLength(3);
  });
});

describe("formatGate", () => {
  it("starts with the marker the workflow finds the comment by, and shows n and the call count", () => {
    const md = formatGate(runGate(baseline, baseline, rules, undefined), baseline, baseline, { baseline: "main", rules: "main" });
    expect(md.startsWith(GATE_COMMENT_MARKER)).toBe(true);
    expect(md).toMatch(/n = 100/);
    expect(md).toMatch(/100 real, 0 from cache, 0 failed/);
    expect(md).toMatch(/Both correct by slice/);
  });
  it("never shows a test ticket's id", () => {
    const worse = withChanges((t, i) => (i === 50 ? ticket(t.id, "low") : t));
    const md = formatGate(runGate(baseline, worse, rules, undefined), baseline, worse, { baseline: "main", rules: "main" });
    expect(md).toMatch(/❌ failed/);
    expect(md).not.toMatch(/t50/);
  });
});

describe("checkGoldenChange", () => {
  const row = (id: string): GoldenRow => ({ id, source: "messy", split: splitFor(id), category: "order", priority: "low", text: `ticket ${id}` });
  const rows = [row("messy-01"), row("messy-02")];
  const changelog = `- **v1** first\n- **${GOLDEN_VERSION}** second`;
  const current = serializeGolden(GOLDEN_VERSION, rows);
  const file = "evals/golden.jsonl";

  it("passes an unchanged set", () => {
    expect(checkGoldenChange({ base: current, head: current, changelog, file })).toEqual([]);
  });
  it("fails a changed set that kept its version", () => {
    const edited = serializeGolden(GOLDEN_VERSION, [...rows, row("messy-03")]);
    expect(checkGoldenChange({ base: current, head: edited, changelog, file }).join(" ")).toMatch(/version didn't go up/);
  });
  it("passes a bump with a changelog line", () => {
    const old = serializeGolden("v1", rows.slice(1));
    expect(checkGoldenChange({ base: old, head: current, changelog, file })).toEqual([]);
  });
  it("fails a bump without a changelog line", () => {
    const old = serializeGolden("v1", rows.slice(1));
    expect(checkGoldenChange({ base: old, head: current, changelog: "- **v1** first", file }).join(" ")).toMatch(/no line for/);
  });
  it("fails a hand edit that broke the hash", () => {
    expect(checkGoldenChange({ base: current, head: current.replace("ticket messy-01", "ticket messy-1"), changelog, file }).join(" ")).toMatch(/still says/);
  });
  it("fails a row moved to the other split", () => {
    const moved = serializeGolden(GOLDEN_VERSION, [{ ...row("messy-01"), split: splitFor("messy-01") === "dev" ? "test" : "dev" }, row("messy-02")]);
    expect(checkGoldenChange({ base: undefined, head: moved, changelog, file }).join(" ")).toMatch(/split their id/);
  });
});
