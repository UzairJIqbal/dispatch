import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEval } from "../src/eval/run.js";
import { ResponseCache } from "../src/gateway/cache.js";
import { Gateway, type GatewayOptions } from "../src/gateway/gateway.js";
import type { GoldenRow } from "../src/golden/schema.js";
import { createApp } from "../src/server/app.js";
import { hashKey, newClientKey, parseClientKeys } from "../src/server/clients.js";
import { parseTracingConfig, type TracingConfig } from "../src/tracing/config.js";
import { redact, setupTracing, traceMixin, WarnOnceExporter } from "../src/tracing/tracing.js";
import { triage } from "../src/triage/triage.js";

// Every test runs on the mock provider with spans going to memory: zero real
// calls, nothing leaves the process.

const KEY = newClientKey();
const clients = parseClientKeys(`acme:${hashKey(KEY)}`);
const EMAIL = "jane.doe@example.com";
const PHONE = "+92 300 1234567";
const TICKET = `I was charged twice for order 5521, please refund me. Reach me at ${EMAIL} or ${PHONE}.`;

const config = (over: Partial<TracingConfig> = {}): TracingConfig => ({ sampleRate: 1, captureContent: false, langfuse: undefined, ...over });

let exporter: InMemorySpanExporter;
let warnings: string[];
function trace(over: Partial<TracingConfig> = {}, exp: SpanExporter = exporter): void {
  setupTracing({ config: config(over), warn: (m) => warnings.push(m), exporter: exp });
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  warnings = [];
  trace();
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(mocks: GatewayOptions["mocks"] = {}): Promise<{ url: string; logs: Record<string, unknown>[] }> {
  const logs: Record<string, unknown>[] = [];
  // The same mixin the service uses.
  const log = pino({ base: null, mixin: traceMixin }, { write: (s: string) => logs.push(JSON.parse(s) as Record<string, unknown>) });
  const gateway = new Gateway({ mocks: { mock: {}, mock_fallback: {}, ...mocks }, log, random: () => 0.5 });
  const app = createApp({
    clients,
    limiter: { check: () => Promise.resolve({ allowed: true }) },
    promptVersion: "v2",
    triage: (text, { log: requestLog }) => triage(text, "v2", { gateway, provider: "mock", log: requestLog }),
    readiness: {},
    log,
    isShuttingDown: () => false,
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, logs };
}

const post = (url: string, text = TICKET) =>
  fetch(`${url}/v1/triage`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify({ text }) });

/** The root ends when the response closes, a moment after the client has it. */
async function spansOf(root = "triage.request"): Promise<ReadableSpan[]> {
  for (let i = 0; i < 100 && !exporter.getFinishedSpans().some((s) => s.name === root); i++) await new Promise((r) => setTimeout(r, 10));
  return exporter.getFinishedSpans();
}

const children = (spans: ReadableSpan[], root: ReadableSpan, name: string) =>
  spans.filter((s) => s.name === name && s.parentSpanContext?.spanId === root.spanContext().spanId).sort((a, b) => (a.startTime[0] - b.startTime[0]) * 1e9 + (a.startTime[1] - b.startTime[1]));

/** Every string an exporter would send: attributes, events, status. */
function everything(spans: ReadableSpan[]): string {
  return JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status, resource: s.resource.attributes })));
}

describe("a request's trace", () => {
  it("is one root with one gen_ai.chat child, and its id is in the response and the log line", async () => {
    const { url, logs } = await serve();
    const res = await post(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { trace_id: string } };
    const spans = await spansOf();

    const roots = spans.filter((s) => s.name === "triage.request");
    expect(roots).toHaveLength(1);
    const root = roots[0];
    if (!root) throw new Error("no root");
    expect(root.parentSpanContext).toBeUndefined();
    expect(body.meta.trace_id).toBe(root.spanContext().traceId);
    expect(root.attributes).toMatchObject({
      "http.route": "/v1/triage",
      "http.response.status_code": 200,
      "app.client": "acme",
      "app.prompt_version": "v2",
      "app.release": "stable",
      "app.fallback": false,
      "app.provider": "mock",
    });
    expect(root.attributes["app.error_class"]).toBeUndefined();
    // The rate limit's Redis round trip is accounted for in the trace too.
    expect(children(spans, root, "ratelimit.check")).toHaveLength(1);

    const chats = children(spans, root, "gen_ai.chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "mock",
      "gen_ai.request.model": "mock-triage-1",
      "gen_ai.response.finish_reasons": ["stop"],
      "app.provider": "mock",
      "app.attempt": 1,
      // Carried down from the root, so Langfuse can filter any observation by it.
      "app.prompt_version": "v2",
    });
    expect(chats[0]?.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(chats[0]?.attributes["gen_ai.usage.output_tokens"]).toBeGreaterThan(0);
    // Old name, renamed in the conventions: must not come back.
    expect(chats[0]?.attributes["gen_ai.system"]).toBeUndefined();

    const tid = root.spanContext().traceId;
    const requestLine = logs.find((l) => l.event === "request");
    expect(requestLine?.trace_id).toBe(tid);
    const attemptLine = logs.find((l) => l.event === "gateway.attempt");
    expect(attemptLine?.trace_id).toBe(tid);
  });

  it("with the primary at 500: three failed attempts, two retry waits with their lengths, then the fallback", async () => {
    const { url } = await serve({ mock: { mode: "500" } });
    const res = await post(url);
    expect(res.status).toBe(200);
    const spans = await spansOf();
    const root = spans.find((s) => s.name === "triage.request");
    if (!root) throw new Error("no root");

    const chats = children(spans, root, "gen_ai.chat");
    expect(chats.map((s) => [s.attributes["app.provider"], s.attributes["app.attempt"], s.attributes["app.error_class"] ?? null])).toEqual([
      ["mock", 1, "provider_5xx"],
      ["mock", 2, "provider_5xx"],
      ["mock", 3, "provider_5xx"],
      ["mock_fallback", 1, null],
    ]);
    expect(chats[3]?.attributes["app.fallback"]).toBe(true);

    // random() is 0.5: half of 500 ms, then half of 1000 ms.
    const waits = children(spans, root, "gateway.retry_wait");
    expect(waits.map((s) => s.attributes["app.wait_ms"])).toEqual([250, 500]);
    expect(root.events.filter((e) => e.name === "gateway.retry_wait").map((e) => e.attributes?.["app.wait_ms"])).toEqual([250, 500]);

    expect(children(spans, root, "gateway.fallback")[0]?.attributes).toMatchObject({ "app.from": "mock", "app.to": "mock_fallback", "app.error_class": "provider_5xx" });
    expect(root.events.some((e) => e.name === "gateway.fallback")).toBe(true);
    expect(root.attributes["app.fallback"]).toBe(true);
  });

  it("records a repair retry as a decision", async () => {
    const { url } = await serve({ mock: { mode: "bad_json_once" } });
    expect((await post(url)).status).toBe(200);
    const spans = await spansOf();
    const root = spans.find((s) => s.name === "triage.request");
    if (!root) throw new Error("no root");
    const chats = children(spans, root, "gen_ai.chat");
    expect(chats.map((s) => [s.attributes["app.repair"], s.attributes["app.error_class"] ?? null])).toEqual([
      [false, "schema_fail"],
      [true, null],
    ]);
    expect(root.events.some((e) => e.name === "gateway.repair")).toBe(true);
  });

  it("records a circuit opening", async () => {
    const { url } = await serve({ mock: { mode: "500" } });
    // Five failures open it: three in the first request, two in the second.
    await post(url);
    await post(url);
    await new Promise((r) => setTimeout(r, 50));
    expect(exporter.getFinishedSpans().some((s) => s.name === "gateway.circuit_open" && s.attributes["app.provider"] === "mock")).toBe(true);
  });

  it("puts a gateway failure's class on the root", async () => {
    const { url } = await serve({ mock: { mode: "400" }, mock_fallback: { mode: "400" } });
    expect((await post(url)).status).toBe(502);
    const root = (await spansOf()).find((s) => s.name === "triage.request");
    expect(root?.attributes["app.error_class"]).toBe("bad_request");
    expect(root?.status.code).toBe(2);
  });

  it("traces a refused request too, and never health checks", async () => {
    const { url } = await serve();
    await fetch(`${url}/healthz`);
    const res = await fetch(`${url}/v1/triage`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const spans = await spansOf();
    expect(spans.filter((s) => s.name === "triage.request")).toHaveLength(1);
    expect(spans[0]?.attributes["app.error_class"]).toBe("unauthorized");
  });
});

describe("what leaves the process", () => {
  it("has no ticket text, summary or key in any span by default", async () => {
    const { url } = await serve();
    const res = await post(url);
    const body = (await res.json()) as { summary: string };
    const all = everything(await spansOf());
    for (const secret of ["charged twice", EMAIL, "1234567", body.summary, KEY, hashKey(KEY)]) expect(all).not.toContain(secret);
  });

  it("gives the trace its labels as output, and nothing as input", async () => {
    const { url } = await serve();
    const body = (await (await post(url)).json()) as { category: string; priority: string };
    const root = (await spansOf()).find((s) => s.name === "triage.request");
    expect(root?.attributes["langfuse.observation.output"]).toBe(JSON.stringify({ category: body.category, priority: body.priority }));
    expect(root?.attributes["langfuse.observation.input"]).toBeUndefined();
  });

  it("with debug capture on, has the text with emails and phone numbers redacted", async () => {
    trace({ captureContent: true });
    const { url } = await serve();
    expect((await post(url)).status).toBe(200);
    const spans = await spansOf();
    const root = spans.find((s) => s.name === "triage.request");
    const input = root?.attributes["langfuse.observation.input"];
    expect(input).toContain("charged twice for order 5521");
    expect(input).toContain("[email]");
    expect(input).toContain("[phone]");
    expect(root?.attributes["langfuse.observation.output"]).toBeTypeOf("string");
    const chat = spans.find((s) => s.name === "gen_ai.chat");
    expect(chat?.attributes["langfuse.observation.input"]).toContain("[email]");
    const all = everything(spans);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain("1234567");
    expect(all).not.toContain(KEY);
  });

  it("redacts the usual email and phone shapes", () => {
    expect(redact("a.b+c@mail.example.co.uk wrote")).toBe("[email] wrote");
    expect(redact("call 0300-1234567 or (021) 555-0100 or +1 415 555 0100")).toBe("call [phone] or [phone] or [phone]");
    // Short numbers stay: an order number of 4 or 5 digits is what a label needs.
    expect(redact("order 5521, 2 items")).toBe("order 5521, 2 items");
  });

  it("refuses the capture under NODE_ENV=production", () => {
    const warned: string[] = [];
    const c = parseTracingConfig({ TRACE_CAPTURE_CONTENT: "true", NODE_ENV: "production" }, (m) => warned.push(m));
    expect(c.captureContent).toBe(false);
    expect(warned).toHaveLength(1);
  });

  it("reads the sample rate from one setting", () => {
    expect(parseTracingConfig({}, () => undefined).sampleRate).toBe(1);
    expect(parseTracingConfig({ TRACE_SAMPLE_RATE: "0.1" }, () => undefined).sampleRate).toBe(0.1);
    expect(() => parseTracingConfig({ TRACE_SAMPLE_RATE: "10" }, () => undefined)).toThrow(/TRACE_SAMPLE_RATE/);
  });

  it("traces nothing at a sample rate of 0, and the request still works", async () => {
    trace({ sampleRate: 0 });
    const { url } = await serve();
    expect((await post(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("a broken exporter", () => {
  it("never breaks a request and warns once", async () => {
    // Like a wrong key: every export fails. A stopped exporter refuses every batch.
    const failing = new InMemorySpanExporter();
    await failing.shutdown();
    const logged: { trace_id?: string }[] = [];
    trace({}, new WarnOnceExporter(failing, (m) => { warnings.push(m); logged.push(traceMixin()); }));
    const { url } = await serve();
    for (let i = 0; i < 3; i++) expect((await post(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(warnings).toHaveLength(1);
    // The warning is about Langfuse, not about the request whose span it was sending.
    expect(logged).toEqual([{}]);
    expect(warnings[0]).toContain("stopped");
    expect(warnings[0]).toContain("LANGFUSE_SECRET_KEY");
  });

  it("warns once when Langfuse isn't set up at all", () => {
    setupTracing({ config: config(), warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([expect.stringContaining("LANGFUSE_PUBLIC_KEY")]);
  });
});

describe("the eval's traces", () => {
  it("puts every ticket of a run under one session, with its trace id in the record", async () => {
    const rows: GoldenRow[] = [1, 2, 3].map((n) => ({ id: `t${String(n)}`, source: "messy", split: "dev", category: "refund", priority: "high", text: `ticket ${String(n)}: refund me` }));
    const cache = new ResponseCache(":memory:");
    try {
      const out = await runEval(rows, { version: "v2", provider: "mock", gateway: new Gateway({ mocks: { mock: {}, mock_fallback: {} } }), cache, refresh: false, sessionId: "run-1" });
      const roots = exporter.getFinishedSpans().filter((s) => s.name === "eval.ticket");
      expect(roots).toHaveLength(3);
      expect(new Set(roots.map((s) => s.attributes["langfuse.session.id"]))).toEqual(new Set(["run-1"]));
      expect(new Set(roots.map((s) => s.spanContext().traceId)).size).toBe(3);
      expect(roots[0]?.attributes["app.expected_category"]).toBe("refund");
      expect(roots[0]?.attributes["app.expected_priority"]).toBe("high");
      expect(out.records.map((r) => r.trace_id).sort()).toEqual(roots.map((s) => s.spanContext().traceId).sort());
      // Its model attempts carry the session too.
      expect(exporter.getFinishedSpans().filter((s) => s.name === "gen_ai.chat").every((s) => s.attributes["langfuse.session.id"] === "run-1")).toBe(true);
    } finally {
      cache.close();
    }
  });
});
