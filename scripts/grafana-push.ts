import { readFileSync } from "node:fs";
import { z } from "zod";
import { gitSha, loadEnv } from "../src/env.js";
import { CONTACT_POINT, FOLDER, cloudDashboard, cloudPrometheusUid, cloudRuleGroup } from "../src/grafana/cloud.js";
import { paths } from "../src/paths.js";
import { run } from "./run.js";

// `pnpm grafana:push`: puts the committed dashboard and both alert rules into
// Grafana Cloud, and an email contact point for the alerts. Safe to run again:
// each thing is replaced by uid, so Cloud always matches the files. The rules
// arrive marked "provisioned" and can't be edited in the UI: change the file,
// then push.

const HINTS: Record<string, string> = {
  GRAFANA_URL: "Your stack's address, e.g. https://yourstack.grafana.net (grafana.com → My Account → your stack).",
  GRAFANA_TOKEN: "In your stack: Administration → Users and access → Service accounts → Add (role Admin) → Add service account token.",
  ALERT_EMAIL: "The address alerts are emailed to.",
};

run(async () => {
  loadEnv();
  const env = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set. ${HINTS[name] ?? ""} Put it in .env in the repo root.`);
    return v;
  };
  const base = env("GRAFANA_URL").replace(/\/+$/, "");
  const token = env("GRAFANA_TOKEN");
  const email = z.email().parse(env("ALERT_EMAIL"));

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (res.status === 401 || res.status === 403) throw new Error(`Grafana said ${String(res.status)} to ${method} ${path}. ${HINTS.GRAFANA_TOKEN ?? ""}`);
    return { status: res.status, json };
  }
  const must = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const r = await api(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} failed with ${String(r.status)}: ${JSON.stringify(r.json)}`);
    return r.json;
  };

  const datasourceUid = cloudPrometheusUid(await must("GET", "/api/datasources"));
  console.log(`Data source: ${datasourceUid}`);

  if ((await api("GET", `/api/folders/${FOLDER.uid}`)).status === 404) await must("POST", "/api/folders", FOLDER);
  console.log(`Folder: ${FOLDER.title}`);

  const contact = { uid: CONTACT_POINT, name: CONTACT_POINT, type: "email", settings: { addresses: email }, disableResolveMessage: false };
  const existing = z.array(z.object({ uid: z.string() })).parse(await must("GET", `/api/v1/provisioning/contact-points?name=${CONTACT_POINT}`));
  if (existing.some((c) => c.uid === CONTACT_POINT)) await must("PUT", `/api/v1/provisioning/contact-points/${CONTACT_POINT}`, contact);
  else await must("POST", "/api/v1/provisioning/contact-points", contact);
  console.log(`Contact point: ${CONTACT_POINT} → ${email}`);

  for (const file of ["fast-burn.yaml", "cost-spike.yaml"]) {
    const group = cloudRuleGroup(readFileSync(`${paths.root}ops/grafana/provisioning/alerting/${file}`, "utf8"), datasourceUid);
    await must("PUT", `/api/v1/provisioning/folder/${FOLDER.uid}/rule-groups/${encodeURIComponent(group.name)}`, group.body);
    console.log(`Alert rules: ${group.name} (${file})`);
  }

  const dashboard = cloudDashboard(JSON.parse(readFileSync(`${paths.root}ops/grafana/dispatch.json`, "utf8")), datasourceUid);
  const saved = z
    .object({ url: z.string() })
    .parse(await must("POST", "/api/dashboards/db", { dashboard, folderUid: FOLDER.uid, overwrite: true, message: `pnpm grafana:push at ${gitSha()}` }));
  console.log(`Dashboard: ${base}${saved.url}`);
});
