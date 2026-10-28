// `pnpm grafana:push`: the committed dashboard and alert files are the one
// source of truth, locally (docker compose provisions them) and in Grafana
// Cloud (this pushes them). The only differences are made here, as pure
// functions: Cloud's data source has another uid, and Cloud alerts need a
// contact point to email.
import { parse } from "yaml";
import { z } from "zod";

/** The uid docker compose gives the local Prometheus; every file points at it. */
export const LOCAL_DATASOURCE_UID = "prometheus";
export const FOLDER = { uid: "dispatch", title: "Dispatch" };
export const CONTACT_POINT = "dispatch-email";

const DataSourceListSchema = z.array(z.object({ uid: z.string(), name: z.string(), type: z.string() }));

/** The stack's hosted Prometheus (Mimir), named grafanacloud-<stack>-prom. */
export function cloudPrometheusUid(list: unknown): string {
  const all = DataSourceListSchema.parse(list);
  const found = all.filter((d) => d.type === "prometheus" && /^grafanacloud-.+-prom$/.test(d.name));
  if (found.length !== 1 || !found[0]) {
    const names = all.filter((d) => d.type === "prometheus").map((d) => d.name);
    throw new Error(`Expected exactly one grafanacloud-<stack>-prom data source, found ${String(found.length)}. Prometheus data sources: ${names.join(", ") || "none"}.`);
  }
  return found[0].uid;
}

/** Every reference to the local data source, swapped for Cloud's. */
function swapDatasource(value: unknown, uid: string): unknown {
  if (Array.isArray(value)) return value.map((v) => swapDatasource(v, uid));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = (k === "uid" || k === "datasourceUid") && v === LOCAL_DATASOURCE_UID ? uid : swapDatasource(v, uid);
  }
  return out;
}

const DashboardSchema = z.looseObject({ uid: z.string(), title: z.string(), refresh: z.string().optional() });

export function cloudDashboard(json: unknown, datasourceUid: string): Record<string, unknown> {
  const d = DashboardSchema.parse(swapDatasource(json, datasourceUid));
  // Grafana Cloud scrapes once a minute; refreshing faster only redraws the same points.
  return { ...d, id: null, refresh: "1m" };
}

const AlertQuerySchema = z.strictObject({
  refId: z.string(),
  datasourceUid: z.string(),
  relativeTimeRange: z.strictObject({ from: z.number(), to: z.number() }).optional(),
  model: z.record(z.string(), z.unknown()),
});
// Strict, so a field added to a file later fails here instead of being quietly left out of Cloud.
const AlertRuleSchema = z.strictObject({
  uid: z.string(),
  title: z.string(),
  condition: z.string(),
  data: z.array(AlertQuerySchema),
  noDataState: z.enum(["OK", "NoData", "Alerting", "KeepLast"]),
  execErrState: z.enum(["OK", "Error", "Alerting", "KeepLast"]),
  for: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
});
const AlertFileSchema = z.strictObject({
  apiVersion: z.literal(1),
  groups: z
    .array(z.strictObject({ orgId: z.number(), name: z.string(), folder: z.string(), interval: z.string().regex(/^\d+[smh]$/), rules: z.array(AlertRuleSchema) }))
    .length(1),
});

const UNIT_S: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600 };
function seconds(duration: string): number {
  const m = /^(\d+)([smh])$/.exec(duration);
  const unit = m?.[2] === undefined ? undefined : UNIT_S[m[2]];
  if (!m || unit === undefined) throw new Error(`not a duration: ${duration}`);
  return Number(m[1]) * unit;
}

export type RuleGroupBody = { name: string; body: Record<string, unknown> };

/** One alert file as the body of Grafana's "replace a rule group" API. */
export function cloudRuleGroup(yamlText: string, datasourceUid: string): RuleGroupBody {
  const group = AlertFileSchema.parse(parse(yamlText)).groups[0];
  if (!group) throw new Error("no rule group");
  const rules = group.rules.map((r) => ({
    ...r,
    data: r.data.map((q) => ({ ...q, datasourceUid: q.datasourceUid === LOCAL_DATASOURCE_UID ? datasourceUid : q.datasourceUid })),
    folderUID: FOLDER.uid,
    ruleGroup: group.name,
    orgID: group.orgId,
    // Straight to the email contact point, without editing the stack's
    // notification policy tree (which other things in the stack may use).
    notification_settings: { receiver: CONTACT_POINT },
  }));
  return { name: group.name, body: { title: group.name, folderUid: FOLDER.uid, interval: seconds(group.interval), rules } };
}
