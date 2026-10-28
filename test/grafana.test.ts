// `pnpm grafana:push` sends the committed files to Grafana Cloud with only
// the data source swapped. These check the swap is complete and the rest is
// untouched, with no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT_POINT, FOLDER, LOCAL_DATASOURCE_UID, cloudDashboard, cloudPrometheusUid, cloudRuleGroup } from "../src/grafana/cloud.js";
import { paths } from "../src/paths.js";
import { z } from "zod";

const read = (p: string) => readFileSync(`${paths.root}${p}`, "utf8");
const CLOUD = "grafanacloud-prom";
const Obj = z.record(z.string(), z.unknown());

describe("cloudPrometheusUid", () => {
  const cloud = { uid: CLOUD, name: "grafanacloud-mystack-prom", type: "prometheus" };
  it("finds the stack's hosted Prometheus", () => {
    expect(cloudPrometheusUid([cloud, { uid: "l", name: "grafanacloud-mystack-logs", type: "loki" }, { uid: "u", name: "grafanacloud-usage", type: "prometheus" }])).toBe(CLOUD);
  });
  it("refuses none or several, listing what is there", () => {
    expect(() => cloudPrometheusUid([{ uid: "u", name: "grafanacloud-usage", type: "prometheus" }])).toThrow(/found 0.*grafanacloud-usage/);
    expect(() => cloudPrometheusUid([cloud, { ...cloud, uid: "b", name: "grafanacloud-other-prom" }])).toThrow(/found 2/);
  });
});

describe("cloudDashboard", () => {
  const original: unknown = JSON.parse(read("ops/grafana/dispatch.json"));
  const d = cloudDashboard(original, CLOUD);
  it("points every panel at Cloud's data source", () => {
    const text = JSON.stringify(d);
    expect(text).not.toContain(`"uid":"${LOCAL_DATASOURCE_UID}"`);
    expect(text).toContain(`"uid":"${CLOUD}"`);
  });
  it("keeps the uid, refreshes at the scrape interval, and changes nothing else", () => {
    expect(d.uid).toBe("dispatch");
    expect(d.refresh).toBe("1m");
    expect(d.id).toBeNull();
    const back = Obj.parse(JSON.parse(JSON.stringify(d).replaceAll(`"uid":"${CLOUD}"`, `"uid":"${LOCAL_DATASOURCE_UID}"`)));
    const changed = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "id" && k !== "refresh"));
    expect(changed(back)).toEqual(changed(Obj.parse(original)));
  });
});

describe("cloudRuleGroup", () => {
  it.each(["fast-burn.yaml", "cost-spike.yaml"])("turns %s into a rule group for the API", (file) => {
    const g = cloudRuleGroup(read(`ops/grafana/provisioning/alerting/${file}`), CLOUD);
    expect(g.body.folderUid).toBe(FOLDER.uid);
    expect(typeof g.body.interval).toBe("number");
    const text = JSON.stringify(g.body);
    expect(text).not.toContain(`"datasourceUid":"${LOCAL_DATASOURCE_UID}"`);
    expect(text).toContain(`"receiver":"${CONTACT_POINT}"`);
  });
  it("converts the interval to seconds", () => {
    const yaml = `apiVersion: 1
groups:
  - orgId: 1
    name: g
    folder: Dispatch
    interval: 2m
    rules: []
`;
    expect(cloudRuleGroup(yaml, CLOUD).body.interval).toBe(120);
  });
  it("refuses a field it doesn't know, instead of dropping it", () => {
    const yaml = `apiVersion: 1
groups:
  - orgId: 1
    name: g
    folder: Dispatch
    interval: 1m
    rules: []
    surprise: true
`;
    expect(() => cloudRuleGroup(yaml, CLOUD)).toThrow();
  });
});
