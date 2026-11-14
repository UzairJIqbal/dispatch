// The eval gate: a candidate's test-split result against main's, rule by
// rule. Pure functions over two results files, so every rule is tested
// without a model call; scripts/gate.ts only reads files and sets the exit code.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { paths, rel } from "../paths.js";
import { frac, secs, usd } from "./report.js";
import type { Noise, Rate, ResultsFile } from "./results.js";

const Pts = z.number().nonnegative();

export const GateRulesSchema = z.strictObject({
  both_correct: z.strictObject({ max_drop_pts: Pts }),
  dangerous_misses: z.strictObject({ max_new: z.number().int().nonnegative() }),
  schema_valid: z.strictObject({ max_drop_pts: Pts }),
  latency_p95: z.strictObject({ max_rise_pct: Pts }),
  cost_per_request: z.strictObject({ max_rise_pct: Pts }),
});
export type GateRules = z.infer<typeof GateRulesSchema>;

export function parseGateRules(text: string, file: string): GateRules {
  const parsed = GateRulesSchema.safeParse(parse(text));
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadGateRules(file = paths.gateRules): GateRules {
  return parseGateRules(readFileSync(file, "utf8"), rel(file));
}

export type Verdict = "pass" | "fail" | "not measured";

export type RuleResult = {
  rule: keyof GateRules;
  name: string;
  baseline: string;
  candidate: string;
  change: string;
  limit: string;
  verdict: Verdict;
};

export type SliceRow = { source: string; baseline: Rate | undefined; candidate: Rate | undefined };

export type GateReport = {
  ok: boolean;
  /** Why the two runs can't be compared at all. When set, no rule ran and the gate fails. */
  mismatch: string[];
  rules: RuleResult[];
  slices: SliceRow[];
};

// Two numbers that should be equal can differ in the last bit after division.
const EPS = 1e-9;

/** From k and n, not the rounded pct, so the limit is compared exactly. */
const ptsOf = (r: Rate) => (r.n === 0 ? 0 : (100 * r.k) / r.n);
const signed = (x: number, unit: string) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}${unit}`;

/**
 * The noise floor that belongs to this baseline: measured on the same prompt,
 * model and golden set. One measured on another setup says nothing about this
 * one, so it is not used: the threshold falls back to the fixed points, which
 * is stricter, never looser.
 */
export function pickNoise(baseline: ResultsFile, candidates: readonly (Noise | undefined)[]): Noise | undefined {
  const r = baseline.run;
  return candidates.find(
    (n) => n !== undefined && n.prompt_version === r.prompt_version && n.provider === r.provider && n.model === r.model && n.dataset_version === r.dataset_version && n.compared > 0,
  );
}

/**
 * The gate grades the same tickets main was graded on, or nothing. A PR can't
 * change which tickets are in test: CI grades with main's golden set, and
 * this check catches anything that still slipped through.
 */
function mismatches(baseline: ResultsFile, candidate: ResultsFile): string[] {
  const out: string[] = [];
  for (const [who, f] of [["baseline", baseline], ["candidate", candidate]] as const) {
    if (f.run.split !== "test") out.push(`The ${who} is a ${f.run.split}-split run; the gate grades on test only.`);
  }
  if (baseline.run.dataset_version !== candidate.run.dataset_version) {
    out.push(`The baseline was graded on golden ${baseline.run.dataset_version} and the candidate on ${candidate.run.dataset_version}.`);
  }
  const expected = (f: ResultsFile) => new Map(f.tickets.map((t) => [t.id, `${t.expected.category}/${t.expected.priority}`]));
  const b = expected(baseline);
  const c = expected(candidate);
  const missing = [...b.keys()].filter((id) => !c.has(id)).length;
  const extra = [...c.keys()].filter((id) => !b.has(id)).length;
  const relabelled = [...b].filter(([id, label]) => c.has(id) && c.get(id) !== label).length;
  if (missing || extra || relabelled) {
    out.push(
      `The candidate was graded on different tickets: ${String(missing)} of the baseline's missing, ${String(extra)} extra, ${String(relabelled)} with different expected labels.`,
    );
  }
  return out;
}

function rateRule(rule: "both_correct" | "schema_valid", name: string, b: Rate, c: Rate, maxDrop: number, limitNote: string): RuleResult {
  const change = ptsOf(c) - ptsOf(b);
  return {
    rule,
    name,
    baseline: frac(b),
    candidate: frac(c),
    change: signed(change, " pts"),
    limit: `drop ≤ ${maxDrop.toFixed(1)} pts${limitNote}`,
    verdict: -change > maxDrop + EPS ? "fail" : "pass",
  };
}

function riseRule(rule: "latency_p95" | "cost_per_request", name: string, b: number, c: number, maxRise: number, show: (x: number) => string, nb: string, nc: string): RuleResult {
  const base = { rule, name, baseline: `${show(b)}${nb}`, candidate: `${show(c)}${nc}`, limit: `rise ≤ ${String(maxRise)}%` };
  // Nothing to scale against: any cost at all where there was none is a rise.
  if (b === 0) return { ...base, change: c === 0 ? "0%" : "new", verdict: c > 0 ? "fail" : "pass" };
  const rise = (100 * (c - b)) / b;
  return { ...base, change: signed(rise, "%"), verdict: rise > maxRise + EPS ? "fail" : "pass" };
}

export function runGate(baseline: ResultsFile, candidate: ResultsFile, rules: GateRules, noise: Noise | undefined): GateReport {
  const mismatch = mismatches(baseline, candidate);
  const B = baseline.metrics;
  const C = candidate.metrics;

  const sources = [...new Set([...Object.keys(B.by_source), ...Object.keys(C.by_source)])];
  const slices = sources.map((source) => ({ source, baseline: B.by_source[source], candidate: C.by_source[source] }));
  if (mismatch.length > 0) return { ok: false, mismatch, rules: [], slices };

  // Both-correct: the fixed points, or the noise floor if that is larger.
  const noisePts = noise ? (100 * noise.both_flips) / noise.compared : undefined;
  const bothLimit = Math.max(rules.both_correct.max_drop_pts, noisePts ?? 0);
  const r = baseline.run;
  const noiseNote =
    noise && noisePts !== undefined
      ? noisePts > rules.both_correct.max_drop_pts
        ? ` (the noise floor: ${String(noise.both_flips)} of ${String(noise.compared)} flipped between two identical runs)`
        : ` (fixed; the noise floor, ${noisePts.toFixed(1)} pts, is smaller)`
      : ` (fixed; no noise floor measured for ${r.prompt_version} on ${r.model}, golden ${r.dataset_version})`;
  const both = rateRule("both_correct", "Both correct", B.both, C.both, bothLimit, noiseNote);

  // Per ticket, so trading one dangerous miss for another still counts.
  const baseDanger = new Set(baseline.tickets.filter((t) => t.grade.dangerous_miss).map((t) => t.id));
  const candDanger = new Set(candidate.tickets.filter((t) => t.grade.dangerous_miss).map((t) => t.id));
  const added = [...candDanger].filter((id) => !baseDanger.has(id)).length;
  const fixed = [...baseDanger].filter((id) => !candDanger.has(id)).length;
  const danger: RuleResult = {
    rule: "dangerous_misses",
    name: "New dangerous misses (high labelled low)",
    baseline: String(B.dangerous_misses),
    candidate: String(C.dangerous_misses),
    change: `${String(added)} new, ${String(fixed)} fixed`,
    limit: `≤ ${String(rules.dangerous_misses.max_new)} new`,
    verdict: added > rules.dangerous_misses.max_new ? "fail" : "pass",
  };

  const schema = rateRule("schema_valid", "Schema-valid first try", B.schema_valid, C.schema_valid, rules.schema_valid.max_drop_pts, "");

  // Latency only from uncached calls. With none on either side there's
  // nothing to judge, and saying "pass" would be a lie.
  const bl = B.latency_s;
  const cl = C.latency_s;
  const latency: RuleResult =
    bl && cl
      ? riseRule("latency_p95", "p95 latency (uncached calls)", bl.p95, cl.p95, rules.latency_p95.max_rise_pct, secs, ` (n=${String(bl.n)})`, ` (n=${String(cl.n)})`)
      : {
          rule: "latency_p95",
          name: "p95 latency (uncached calls)",
          baseline: bl ? `${secs(bl.p95)} (n=${String(bl.n)})` : "no uncached calls",
          candidate: cl ? `${secs(cl.p95)} (n=${String(cl.n)})` : "every call was cached",
          change: "",
          limit: `rise ≤ ${String(rules.latency_p95.max_rise_pct)}%`,
          verdict: "not measured",
        };

  const priceNote = (f: ResultsFile) => ` (n=${String(f.metrics.n)}, ${f.metrics.cost_usd.price_date} prices)`;
  const cost = riseRule(
    "cost_per_request",
    "Cost per request (list price)",
    B.cost_usd.per_request,
    C.cost_usd.per_request,
    rules.cost_per_request.max_rise_pct,
    (x) => `~${usd(x)}`,
    priceNote(baseline),
    priceNote(candidate),
  );

  const results = [both, danger, schema, latency, cost];
  return { ok: results.every((x) => x.verdict !== "fail"), mismatch, rules: results, slices };
}

/**
 * Whether a main run may become the baseline. The gate measures prompts, not
 * the provider's bad minute: a failed call is graded wrong, an answer from the
 * fallback is another model's, and a cached answer has no latency.
 */
export function baselineProblems(f: ResultsFile): string[] {
  const m = f.metrics;
  const out: string[] = [];
  if (f.run.split !== "test") out.push(`it is a ${f.run.split}-split run; the baseline is the test split`);
  if (m.calls.cached > 0) out.push(`${String(m.calls.cached)} of ${String(m.n)} answers came from the cache, so their latency isn't real (run with --no-cache)`);
  if (m.calls.failed > 0) out.push(`${String(m.calls.failed)} of ${String(m.n)} calls failed (${Object.entries(m.errors).map(([k, v]) => `${k} ${String(v)}`).join(", ")})`);
  const fallbacks = m.gateway?.fallbacks ?? 0;
  if (fallbacks > 0) out.push(`${String(fallbacks)} of ${String(m.n)} tickets were answered by the fallback, another model`);
  return out;
}

// ---- the table ----

/** The first line of the PR comment: how the workflow finds it again to update it. */
export const GATE_COMMENT_MARKER = "<!-- dispatch-eval-gate -->";

const ICON: Record<Verdict, string> = { pass: "✅ pass", fail: "❌ fail", "not measured": "⚪ not measured" };

// A table cell can't hold a raw pipe or a line break.
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const row = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;

function describeRun(f: ResultsFile): string {
  const r = f.run;
  return `prompt ${r.prompt_version} · ${r.provider} ${r.model} · git ${r.git_sha} · golden ${r.dataset_version}`;
}

export function formatGate(report: GateReport, baseline: ResultsFile, candidate: ResultsFile, sources: { baseline: string; rules: string }): string {
  const C = candidate.metrics;
  const failed = report.rules.filter((r) => r.verdict === "fail").length;
  const title = report.ok
    ? "## Eval gate: ✅ passed"
    : report.mismatch.length > 0
      ? "## Eval gate: ❌ failed (can't compare with the baseline)"
      : `## Eval gate: ❌ failed (${String(failed)} of ${String(report.rules.length)} rules)`;

  const lines = [
    GATE_COMMENT_MARKER,
    title,
    "",
    `**Candidate:** ${describeRun(candidate)} · test split, n = ${String(C.n)}`,
    `**Baseline:** ${describeRun(baseline)} · test split, n = ${String(baseline.metrics.n)} · ${sources.baseline}`,
    // The gate prints what it spent: a fully cached rerun says 0 here.
    `**Calls this run:** ${String(C.calls.uncached)} real, ${String(C.calls.cached)} from cache, ${String(C.calls.failed)} failed`,
    `**Rules:** ${sources.rules}`,
    "",
  ];

  if (report.mismatch.length > 0) {
    lines.push(...report.mismatch.map((m) => `- ${m}`), "", "No rule was checked: the two runs aren't measuring the same thing.");
  } else {
    lines.push(row(["Rule", "Baseline", "Candidate", "Change", "Limit", "Result"]), row(["---", "---", "---", "---", "---", "---"]));
    for (const r of report.rules) lines.push(row([r.name, r.baseline, r.candidate, r.change, r.limit, ICON[r.verdict]]));
  }

  const fallbacks = C.gateway?.fallbacks ?? 0;
  if (fallbacks > 0 || C.calls.failed > 0) {
    lines.push(
      "",
      `⚠️ ${String(fallbacks)} tickets were answered by the fallback model and ${String(C.calls.failed)} failed. Both count in the numbers above (a failed ticket is graded wrong). If the provider was having a bad minute, rerun the job.`,
    );
  }

  lines.push(
    "",
    "**Both correct by slice** (for information only: slices are too small to gate on)",
    "",
    row(["Slice", "Baseline", "Candidate", "Change"]),
    row(["---", "---", "---", "---"]),
    ...report.slices.map((s) =>
      row([s.source, s.baseline ? frac(s.baseline) : "—", s.candidate ? frac(s.candidate) : "—", s.baseline && s.candidate ? signed(ptsOf(s.candidate) - ptsOf(s.baseline), " pts") : ""]),
    ),
    "",
    `Cost is a list-price estimate; on the free tiers this run cost $0. Test tickets are graded, never shown: only counts appear here.`,
  );
  return lines.join("\n") + "\n";
}
