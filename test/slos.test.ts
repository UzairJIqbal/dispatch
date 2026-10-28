// The SLO numbers live in docs/SLOS.md. The dashboard and the alert rules
// repeat them in PromQL, so this checks every copy against the doc.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { LATENCY_BUCKETS, Metrics } from "../src/metrics/metrics.js";
import { paths } from "../src/paths.js";

const read = (p: string) => readFileSync(`${paths.root}${p}`, "utf8");

const Duration = z.string().regex(/^\d+[mhd]$/);
const SlosSchema = z.strictObject({
  availability: z.strictObject({ target: z.number().gt(0).lt(1), window: Duration }),
  latency: z.strictObject({ p95_seconds: z.number().positive() }),
  cost: z.strictObject({ per_1000_usd: z.number().positive(), baseline_per_1000_usd: z.number().positive() }),
  fast_burn: z.strictObject({ factor: z.number().positive(), long_window: Duration, short_window: Duration }),
  cost_spike: z.strictObject({ factor: z.number().positive(), window: Duration, baseline_window: Duration, for: Duration }),
});

const doc = read("docs/SLOS.md");
const block = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1];
const slos = SlosSchema.parse(parse(block ?? ""));
// 1 - 0.99 in floating point is 0.010000000000000009.
const budget = String(Math.round((1 - slos.availability.target) * 1e6) / 1e6);

const RuleSchema = z.object({
  uid: z.string(),
  for: z.string(),
  data: z.array(z.object({ refId: z.string(), datasourceUid: z.string(), model: z.object({ expr: z.string().optional(), expression: z.string().optional() }) })),
});
const AlertFileSchema = z.object({ groups: z.array(z.object({ folder: z.string(), rules: z.array(RuleSchema) })) });
function rule(file: string): z.infer<typeof RuleSchema> {
  const r = AlertFileSchema.parse(parse(read(`ops/grafana/provisioning/alerting/${file}`))).groups[0]?.rules[0];
  if (!r) throw new Error(`no rule in ${file}`);
  return r;
}
const query = (r: z.infer<typeof RuleSchema>, refId: string) => r.data.find((d) => d.refId === refId)?.model;

const PanelSchema = z.object({
  title: z.string(),
  targets: z.array(z.object({ expr: z.string() })).default([]),
  fieldConfig: z.object({ defaults: z.object({ thresholds: z.object({ steps: z.array(z.object({ value: z.number().nullable() })) }).optional() }) }).optional(),
});
const dashboard = z.object({ panels: z.array(PanelSchema) }).parse(JSON.parse(read("ops/grafana/dispatch.json")));
const panel = (title: string) => {
  const p = dashboard.panels.find((x) => x.title === title);
  if (!p) throw new Error(`no panel "${title}"`);
  return p;
};
const exprs = (title: string) => panel(title).targets.map((t) => t.expr).join("\n");
const steps = (title: string) => panel(title).fieldConfig?.defaults.thresholds?.steps.map((s) => s.value) ?? [];

describe("docs/SLOS.md is the one source of every SLO number", () => {
  it("the latency SLO is a bucket edge, and the dashboard's SLO line", () => {
    expect(LATENCY_BUCKETS).toContain(slos.latency.p95_seconds);
    expect(exprs("Triage latency vs SLO")).toContain(`vector(${String(slos.latency.p95_seconds)})`);
  });

  it("availability and the error budget use the target and its window", () => {
    expect(exprs("Availability, 7 days")).toContain(`[${slos.availability.window}]`);
    expect(steps("Availability, 7 days")).toContain(slos.availability.target);
    expect(exprs("Error budget left")).toContain(`/ ${budget})`);
    expect(exprs("Error budget left")).toContain(`[${slos.availability.window}]`);
    expect(exprs("Availability, rolling 1 h, vs SLO")).toContain(`vector(${String(slos.availability.target)})`);
  });

  it("the fast-burn alert: both windows, the budget and the factor", () => {
    const r = rule("fast-burn.yaml");
    expect(query(r, "A")?.expr).toContain(`[${slos.fast_burn.long_window}]`);
    expect(query(r, "B")?.expr).toContain(`[${slos.fast_burn.short_window}]`);
    for (const ref of ["A", "B"]) expect(query(r, ref)?.expr).toMatch(new RegExp(`\\) / ${budget.replace(".", "\\.")}$`));
    expect(query(r, "C")?.expression).toBe(`$A > ${String(slos.fast_burn.factor)} && $B > ${String(slos.fast_burn.factor)}`);
    expect(exprs("Burn rate, 1 h")).toContain(`/ ${budget}`);
    expect(steps("Burn rate, 1 h")).toContain(slos.fast_burn.factor);
  });

  it("the cost-spike alert: its windows, factor and duration, and the dashboard's threshold line", () => {
    const r = rule("cost-spike.yaml");
    expect(query(r, "A")?.expr).toContain(`[${slos.cost_spike.window}]`);
    expect(query(r, "B")?.expr).toContain(`[${slos.cost_spike.baseline_window}]`);
    expect(query(r, "C")?.expression).toBe(`$A > ${String(slos.cost_spike.factor)} * $B && $B > 0 && $D >= 23`);
    expect(r.for).toBe(slos.cost_spike.for);
    const cost = exprs("Cost per minute (list price)");
    expect(cost).toContain(`${String(slos.cost_spike.factor)} * sum(rate(dispatch_cost_usd_total[${slos.cost_spike.baseline_window}]))`);
    expect(cost).toContain(`[${slos.cost_spike.window}]`);
  });

  it("the cost SLO is the cost panel's red line", () => {
    expect(steps("Cost per 1,000 answers, 7 days")).toContain(slos.cost.per_1000_usd);
  });
});

describe("the dashboard and the alerts", () => {
  it("only use metrics the service exposes", async () => {
    const m = new Metrics();
    m.priceTable("2026-10-27");
    const names = new Set((await m.registry.getMetricsAsJSON()).map((x) => x.name));
    const text = read("ops/grafana/dispatch.json") + read("ops/grafana/provisioning/alerting/fast-burn.yaml") + read("ops/grafana/provisioning/alerting/cost-spike.yaml");
    const used = new Set([...text.matchAll(/dispatch_[a-z_]+/g)].map((x) => x[0].replace(/_(bucket|sum|count)$/, "")));
    expect(used.size).toBeGreaterThan(5);
    for (const u of used) expect(names, u).toContain(u);
  });

  it("point at the provisioned data source", () => {
    const ds = parse(read("ops/grafana/provisioning/datasources/prometheus.yaml")) as unknown;
    const uid = z.object({ datasources: z.array(z.object({ uid: z.string() })) }).parse(ds).datasources[0]?.uid;
    for (const f of ["fast-burn.yaml", "cost-spike.yaml"]) {
      for (const d of rule(f).data) expect(["__expr__", uid]).toContain(d.datasourceUid);
    }
    expect(read("ops/grafana/dispatch.json")).not.toMatch(new RegExp(`"uid": "(?!${uid ?? ""}|dispatch)`));
  });
});
