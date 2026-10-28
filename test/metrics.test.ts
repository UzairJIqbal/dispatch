import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/gateway/config.js";
import { ERROR_CLASSES } from "../src/gateway/errors.js";
import { Gateway, type GatewayOptions } from "../src/gateway/gateway.js";
import { LATENCY_BUCKETS, Metrics, ROUTES } from "../src/metrics/metrics.js";
import { createApp } from "../src/server/app.js";
import { hashKey, newClientKey, parseClientKeys } from "../src/server/clients.js";
import { HTTP_ERRORS } from "../src/server/errors.js";
import { triage } from "../src/triage/triage.js";

const ACME = newClientKey();
const clients = parseClientKeys(`acme:${hashKey(ACME)}`);
const TICKET = "I was charged twice for order 5521, please refund me. Email jane@example.com";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(opts: { mocks?: GatewayOptions["mocks"]; metricsPassword?: string } = {}): Promise<{ url: string; metrics: Metrics }> {
  const log = pino({ level: "silent" });
  const metrics = new Metrics();
  metrics.priceTable("2026-10-27");
  // No jitter, so the 500 drills don't wait on backoff.
  const gateway = new Gateway({ mocks: { mock: {}, mock_fallback: {}, ...opts.mocks }, log, random: () => 0, metrics });
  gateway.prepare("mock");
  const app = createApp({
    clients,
    limiter: { check: () => Promise.resolve({ allowed: true }) },
    promptVersion: "v2",
    triage: (text, { log: requestLog }) => triage(text, "v2", { gateway, provider: "mock", log: requestLog }),
    readiness: {},
    log,
    isShuttingDown: () => false,
    metrics,
    ...(opts.metricsPassword ? { metricsPassword: opts.metricsPassword } : {}),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, metrics };
}

const post = (url: string, body: unknown, key = ACME) =>
  fetch(`${url}/v1/triage`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

/** Lets the response's `close` handler, where requests are counted, run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

async function value(metrics: Metrics, name: string, labels: Record<string, string>): Promise<number> {
  const all = await metrics.registry.getMetricsAsJSON();
  const m = all.find((x) => x.name === name);
  const v = m?.values.find((x) => Object.entries(labels).every(([k, want]) => String(x.labels[k]) === want));
  return v?.value ?? 0;
}

// Every label any metric may carry, and the closed set of values it may take.
// A new label, or a value outside its set, fails here: each distinct value is
// a new time series, and Grafana Cloud's free plan has a series limit.
const ERROR_CLASS_VALUES = new Set<string>([...ERROR_CLASSES, ...Object.keys(HTTP_ERRORS), "none"]);
const PROVIDER_VALUES = new Set<string>([...PROVIDERS, "none"]);
const LABELS: Readonly<Record<string, Readonly<Record<string, (v: string) => boolean>>>> = {
  dispatch_requests_total: { route: (v) => (ROUTES as readonly string[]).includes(v), status: (v) => /^[1-5]\d\d$/.test(v), error_class: (v) => ERROR_CLASS_VALUES.has(v) },
  dispatch_request_duration_seconds: {
    prompt_version: (v) => /^v\d+$/.test(v),
    provider: (v) => PROVIDER_VALUES.has(v),
    release: (v) => v === "stable",
    le: (v) => v === "+Inf" || LATENCY_BUCKETS.map(String).includes(v),
  },
  dispatch_attempt_duration_seconds: { provider: (v) => PROVIDER_VALUES.has(v), le: (v) => v === "+Inf" || LATENCY_BUCKETS.map(String).includes(v) },
  dispatch_gateway_errors_total: { provider: (v) => PROVIDER_VALUES.has(v), error_class: (v) => (ERROR_CLASSES as readonly string[]).includes(v) },
  dispatch_tokens_total: { provider: (v) => PROVIDER_VALUES.has(v), type: (v) => v === "input" || v === "output" },
  dispatch_cost_usd_total: { provider: (v) => PROVIDER_VALUES.has(v) },
  dispatch_fallbacks_total: { from: (v) => PROVIDER_VALUES.has(v), to: (v) => PROVIDER_VALUES.has(v) },
  dispatch_repairs_total: { provider: (v) => PROVIDER_VALUES.has(v) },
  dispatch_schema_failures_total: { provider: (v) => PROVIDER_VALUES.has(v) },
  dispatch_circuit_state: { provider: (v) => PROVIDER_VALUES.has(v) },
  dispatch_price_table_info: { date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) },
};

describe("labels", () => {
  it("every metric and label in use is in the list above, with a value from its closed set", async () => {
    const { url, metrics } = await serve({ mocks: { mock: { mode: ["ok", "500", "500", "500", "bad_json", "ok"] } } });
    // Different tickets, ticket ids and outcomes: none of it may become a label.
    for (let i = 0; i < 6; i++) await post(url, { text: `${TICKET} #${String(i)}`, ticket_id: `T-${String(i)}` });
    await post(url, {});
    await post(url, { text: TICKET }, "dsp_wrong");
    await fetch(`${url}/nope/${String(Math.random())}`);
    await fetch(`${url}/healthz`);
    await settle();

    const all = await metrics.registry.getMetricsAsJSON();
    expect(all.map((m) => m.name).sort()).toEqual(Object.keys(LABELS).sort());
    for (const m of all) {
      const allowed = LABELS[m.name] ?? {};
      for (const v of m.values) {
        for (const [label, val] of Object.entries(v.labels)) {
          const ok = allowed[label];
          expect(ok, `${m.name} has an unlisted label ${label}`).toBeDefined();
          expect(ok?.(String(val)), `${m.name}{${label}="${String(val)}"}`).toBe(true);
        }
      }
    }
    const text = await metrics.registry.metrics();
    for (const leak of ["charged twice", "jane@example.com", "T-1", "acme", ACME, "/nope"]) expect(text).not.toContain(leak);
  });
});

describe("what gets counted", () => {
  it("a healthy request: one 200, its latency, its tokens and its list-price cost", async () => {
    const { url, metrics } = await serve();
    expect((await post(url, { text: TICKET })).status).toBe(200);
    await settle();
    expect(await value(metrics, "dispatch_requests_total", { route: "/v1/triage", status: "200", error_class: "none" })).toBe(1);
    expect(await value(metrics, "dispatch_request_duration_seconds", { le: "+Inf", provider: "mock", prompt_version: "v2", release: "stable" })).toBe(1);
    expect(await value(metrics, "dispatch_tokens_total", { provider: "mock", type: "input" })).toBeGreaterThan(0);
    expect(await value(metrics, "dispatch_cost_usd_total", { provider: "mock" })).toBeGreaterThan(0);
    expect(await value(metrics, "dispatch_circuit_state", { provider: "mock" })).toBe(0);
  });

  it("a client's 400 is counted as a response but not in the latency SLI", async () => {
    const { url, metrics } = await serve();
    expect((await post(url, {})).status).toBe(400);
    await settle();
    expect(await value(metrics, "dispatch_requests_total", { route: "/v1/triage", status: "400", error_class: "bad_request" })).toBe(1);
    expect(await value(metrics, "dispatch_request_duration_seconds", { le: "+Inf" })).toBe(0);
  });

  it("the primary at 500: provider_5xx counted, the fallback answers, the circuit opens, every request is still a 200", async () => {
    const { url, metrics } = await serve({ mocks: { mock: { mode: "500" } } });
    for (let i = 0; i < 3; i++) expect((await post(url, { text: TICKET })).status).toBe(200);
    await settle();
    expect(await value(metrics, "dispatch_gateway_errors_total", { provider: "mock", error_class: "provider_5xx" })).toBe(5);
    // The third request skipped the open primary at once.
    expect(await value(metrics, "dispatch_gateway_errors_total", { provider: "mock", error_class: "circuit_open" })).toBe(1);
    expect(await value(metrics, "dispatch_fallbacks_total", { from: "mock", to: "mock_fallback" })).toBe(3);
    expect(await value(metrics, "dispatch_circuit_state", { provider: "mock" })).toBe(2);
    expect(await value(metrics, "dispatch_circuit_state", { provider: "mock_fallback" })).toBe(0);
    expect(await value(metrics, "dispatch_requests_total", { route: "/v1/triage", status: "200" })).toBe(3);
    // The fallback is priced on its own.
    expect(await value(metrics, "dispatch_cost_usd_total", { provider: "mock_fallback" })).toBeGreaterThan(0);
  });

  it("every provider down: the 503 is counted under the gateway's class", async () => {
    const { url, metrics } = await serve({ mocks: { mock: { mode: "500" }, mock_fallback: { mode: "500" } } });
    expect((await post(url, { text: TICKET })).status).toBe(503);
    await settle();
    expect(await value(metrics, "dispatch_requests_total", { route: "/v1/triage", status: "503", error_class: "provider_5xx" })).toBe(1);
    expect(await value(metrics, "dispatch_request_duration_seconds", { le: "+Inf", provider: "mock_fallback" })).toBe(1);
  });

  it("a broken answer twice: one repair, one schema failure", async () => {
    const { url, metrics } = await serve({ mocks: { mock: { mode: "bad_json" } } });
    expect((await post(url, { text: TICKET })).status).toBe(502);
    await settle();
    expect(await value(metrics, "dispatch_repairs_total", { provider: "mock" })).toBe(1);
    expect(await value(metrics, "dispatch_schema_failures_total", { provider: "mock" })).toBe(1);
    expect(await value(metrics, "dispatch_requests_total", { route: "/v1/triage", status: "502", error_class: "schema_fail" })).toBe(1);
  });

  it("the failure classes start at 0, so the first one is a visible increase", async () => {
    const { metrics } = await serve();
    const text = await metrics.registry.metrics();
    expect(text).toContain('dispatch_requests_total{route="/v1/triage",status="503",error_class="provider_5xx"} 0');
    expect(text).toContain('dispatch_gateway_errors_total{provider="mock",error_class="timeout"} 0');
  });
});

describe("GET /metrics", () => {
  it("is open without a password", async () => {
    const { url } = await serve();
    const res = await fetch(`${url}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("dispatch_requests_total");
  });

  it("asks for basic auth when METRICS_PASSWORD is set", async () => {
    const password = "a-long-test-password";
    const { url } = await serve({ metricsPassword: password });
    const basic = (s: string) => ({ authorization: `Basic ${Buffer.from(s).toString("base64")}` });
    const none = await fetch(`${url}/metrics`);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Basic");
    expect((await fetch(`${url}/metrics`, { headers: basic("metrics:wrong") })).status).toBe(401);
    expect((await fetch(`${url}/metrics`, { headers: basic(`admin:${password}`) })).status).toBe(401);
    expect((await fetch(`${url}/metrics`, { headers: basic(`metrics:${password}`) })).status).toBe(200);
  });
});
