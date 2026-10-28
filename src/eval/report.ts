import type { Price } from "../gateway/config.js";
import { SOURCES } from "../golden/schema.js";
import type { Metrics, Noise, Rate, ResultsFile, RunInfo, TicketRecord } from "./results.js";

export function rate(k: number, n: number): Rate {
  return { pct: n === 0 ? 0 : Math.round((10_000 * k) / n) / 100, k, n };
}

/** Nearest-rank percentile: always a latency that was actually observed. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of nothing");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
}

const count = (records: readonly TicketRecord[], pred: (r: TicketRecord) => boolean) => records.filter(pred).length;

/**
 * `price` is the primary model's; `prices` holds the others by provider, so
 * a fallback answer is priced at the fallback's list price.
 */
export function computeMetrics(records: readonly TicketRecord[], price: Price, priceDate: string, prices: Readonly<Partial<Record<string, Price>>> = {}): Metrics {
  const n = records.length;
  const answered = records.filter((r) => r.answer !== null);
  const called = records.filter((r) => r.latency_ms !== null);

  // Latency only from calls that really went to the provider. Cached answers
  // would make every percentile look amazing and mean nothing.
  const uncachedLatencies = called.filter((r) => !r.cached).map((r) => (r.latency_ms ?? 0) / 1000);

  const bySource: Record<string, Rate> = {};
  for (const source of SOURCES) {
    const slice = records.filter((r) => r.source === source);
    if (slice.length > 0) bySource[source] = rate(count(slice, (r) => r.grade.both), slice.length);
  }

  const errors: Record<string, number> = {};
  for (const r of records) if (r.error) errors[r.error.class] = (errors[r.error.class] ?? 0) + 1;

  const inTotal = called.reduce((s, r) => s + r.tokens_in, 0);
  const outTotal = called.reduce((s, r) => s + r.tokens_out, 0);
  const costTotal = called.reduce((s, r) => {
    const p = (r.provider ? prices[r.provider] : undefined) ?? price;
    return s + (r.tokens_in * p.input + r.tokens_out * p.output) / 1_000_000;
  }, 0);

  return {
    n,
    both: rate(count(records, (r) => r.grade.both), n),
    category: rate(count(records, (r) => r.grade.category), n),
    priority: rate(count(records, (r) => r.grade.priority), n),
    dangerous_misses: count(records, (r) => r.grade.dangerous_miss),
    schema_valid: rate(count(answered, (r) => r.repaired !== true), n),
    success: rate(answered.length, n),
    summary_ok: rate(count(answered, (r) => r.grade.summary?.ok === true), answered.length),
    by_source: bySource,
    errors,
    calls: { cached: count(called, (r) => r.cached), uncached: uncachedLatencies.length, failed: n - called.length },
    latency_s:
      uncachedLatencies.length === 0
        ? null
        : {
            n: uncachedLatencies.length,
            p50: percentile(uncachedLatencies, 50),
            p95: percentile(uncachedLatencies, 95),
            p99: percentile(uncachedLatencies, 99),
          },
    tokens: {
      in_avg: called.length ? Math.round(inTotal / called.length) : 0,
      out_avg: called.length ? Math.round(outTotal / called.length) : 0,
      in_total: inTotal,
      out_total: outTotal,
    },
    cost_usd: { per_request: called.length ? costTotal / called.length : 0, total: costTotal, price_date: priceDate },
    gateway: {
      retries: records.reduce((s, r) => s + (r.retries ?? 0), 0),
      fallbacks: count(records, (r) => r.fallback === true),
      repairs: count(records, (r) => r.repaired === true),
    },
  };
}

// ---- formatting ----

const pct = (r: Rate) => `${r.pct.toFixed(1)}%`;
const frac = (r: Rate) => `${pct(r)} (${String(r.k)}/${String(r.n)})`;
const secs = (s: number) => `${s.toFixed(2)} s`;
const usd = (x: number) => `$${x < 0.01 ? x.toPrecision(2) : x.toFixed(4)}`;

function delta(now: Rate, then: Rate | undefined): string {
  if (!then) return "";
  const d = now.pct - then.pct;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)} pts`;
}

type Row = [label: string, now: string, then: string, change: string];

function table(rows: readonly Row[]): string {
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
  return rows.map((r) => `${r[0].padEnd(w[0] ?? 0)}  ${r[1].padEnd(w[1] ?? 0)}  ${r[2].padEnd(w[2] ?? 0)}  ${r[3]}`.trimEnd()).join("\n");
}

function latencyText(m: Metrics): string {
  if (!m.latency_s) return "no uncached calls";
  const l = m.latency_s;
  return `${secs(l.p50)} / ${secs(l.p95)} / ${secs(l.p99)} (n=${String(l.n)} uncached)`;
}

function gatewayText(m: Metrics, b: Metrics | undefined): string {
  const g = m.gateway;
  if (!g) return "Gateway: not recorded (results from before Phase 4)";
  const then = b ? (b.gateway ? ` · baseline: ${String(b.gateway.retries)} retries, ${String(b.gateway.fallbacks)} fallbacks, ${String(b.gateway.repairs)} repairs (n=${String(b.n)})` : " · baseline: not recorded") : "";
  return `Gateway (n=${String(m.n)}): ${String(g.retries)} retries · ${String(g.fallbacks)} answered by the fallback · ${String(g.repairs)} repaired${then}`;
}

export function formatReport(
  run: RunInfo,
  m: Metrics,
  comparison: { label: string; file: ResultsFile } | undefined,
  noise: Noise | undefined,
): string {
  const b = comparison?.file.metrics;
  const then = (s: string | undefined) => (b ? (s ?? "") : "");
  const rows: Row[] = [
    ["", "this run", comparison ? comparison.label : "no baseline yet", ""],
    ["both correct", frac(m.both), then(b && `${pct(b.both)} (n=${String(b.n)})`), delta(m.both, b?.both)],
    ["category", frac(m.category), then(b && pct(b.category)), delta(m.category, b?.category)],
    ["priority", frac(m.priority), then(b && pct(b.priority)), delta(m.priority, b?.priority)],
    ["dangerous misses", `${String(m.dangerous_misses)} (high labelled low)`, then(b && String(b.dangerous_misses)), ""],
    ["schema-valid 1st try", frac(m.schema_valid), then(b && pct(b.schema_valid)), delta(m.schema_valid, b?.schema_valid)],
    ["success", frac(m.success), then(b && pct(b.success)), delta(m.success, b?.success)],
    ["summary checks", frac(m.summary_ok), then(b && pct(b.summary_ok)), delta(m.summary_ok, b?.summary_ok)],
    ["latency p50/p95/p99", latencyText(m), then(b && (b.latency_s ? `${secs(b.latency_s.p50)} / ${secs(b.latency_s.p95)} / ${secs(b.latency_s.p99)}` : "n/a")), ""],
    ["tokens per request", `in ${String(m.tokens.in_avg)} · out ${String(m.tokens.out_avg)}`, then(b && `in ${String(b.tokens.in_avg)} · out ${String(b.tokens.out_avg)}`), ""],
    ["cost per request", `~${usd(m.cost_usd.per_request)}`, then(b && `~${usd(b.cost_usd.per_request)}`), ""],
  ];

  const slices: Row[] = Object.entries(m.by_source).map(([source, r]) => {
    const old = b?.by_source[source];
    return [`  ${source}`, frac(r), then(old && `${pct(old)} (n=${String(old.n)})`), delta(r, old)];
  });

  const errors = Object.entries(m.errors).map(([c, k]) => `${c} ${String(k)}`);
  const lines = [
    `Dispatch eval · prompt ${run.prompt_version} · ${run.provider} ${run.model} · ${run.split} split · golden ${run.dataset_version} · git ${run.git_sha}`,
    `n = ${String(m.n)} ${run.split} tickets · calls: ${String(m.calls.uncached)} uncached, ${String(m.calls.cached)} cached (left out of latency), ${String(m.calls.failed)} failed`,
    "",
    table([...rows, ["both correct by slice", "", "", ""], ...slices]),
    "",
    `Cost is a list-price estimate (${m.cost_usd.price_date} price table); on the free tier this run cost $0. Whole run at list price: ~${usd(m.cost_usd.total)}.`,
    `Slices are shown, never gated: too small to gate on.`,
    errors.length ? `Errors: ${errors.join(" · ")}` : "Errors: none",
    gatewayText(m, b),
  ];
  if (noise) {
    lines.push(
      `Noise floor: ${String(noise.flips)} of ${String(noise.compared)} ${noise.split} tickets flipped between two identical uncached runs ` +
        `(${String(noise.both_flips)} changed both-correct; ${String(noise.failed_ids.length)} failed and left out; ${noise.prompt_version}, ${noise.provider}).`,
    );
  }
  return lines.join("\n");
}
