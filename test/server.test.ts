import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitSha } from "../src/env.js";
import { ProviderError } from "../src/gateway/errors.js";
import { parseReleaseConfig } from "../src/release/config.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import { clientForKey, hashKey, newClientKey, parseClientKeys } from "../src/server/clients.js";
import { parseServiceConfig } from "../src/server/config.js";
import { retryAfterSeconds, type Limiter } from "../src/server/ratelimit.js";
import { Gateway, type GatewayOptions } from "../src/gateway/gateway.js";
import { Metrics } from "../src/metrics/metrics.js";
import { triage, type TriageResult } from "../src/triage/triage.js";

const ACME = newClientKey();
const BETA = newClientKey();
const clients = parseClientKeys(`acme:${hashKey(ACME)},beta:${hashKey(BETA)}`);

/** The same sliding-window promise as Upstash, in memory: `limit` requests per client, then refused. */
function memoryLimiter(limit: number): Limiter {
  const counts = new Map<string, number>();
  return {
    check(client) {
      const n = (counts.get(client) ?? 0) + 1;
      counts.set(client, n);
      return Promise.resolve(n <= limit ? { allowed: true } : { allowed: false, retryAfterS: 42 });
    },
  };
}

type Captured = { lines: Record<string, unknown>[] };

async function serve(overrides: Partial<AppDeps> = {}, mocks: GatewayOptions["mocks"] = {}): Promise<{ url: string; server: Server; logs: Captured }> {
  const logs: Captured = { lines: [] };
  const log = pino({ base: null }, { write: (s: string) => logs.lines.push(JSON.parse(s) as Record<string, unknown>) });
  // No jitter, so a retry doesn't make the test wait.
  const metrics = new Metrics();
  const gateway = new Gateway({ mocks: { mock: {}, mock_fallback: {}, ...mocks }, log, random: () => 0, metrics });
  const app = createApp({
    clients,
    limiter: memoryLimiter(60),
    promptVersion: "v2",
    // The real triage(), on the mock provider: zero real calls.
    triage: (text, { log: requestLog }) => triage(text, "v2", { gateway, provider: "mock", log: requestLog }),
    readiness: { config: () => Promise.resolve(), redis: () => Promise.resolve() },
    log,
    isShuttingDown: () => false,
    metrics,
    ...overrides,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, server, logs };
}

const post = (url: string, body: unknown, key?: string) =>
  fetch(`${url}/v1/triage`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const TICKET = "I was charged twice for order 5521, please refund me. Email jane@example.com";

describe("POST /v1/triage", () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    s = await serve();
  });
  afterAll(() => {
    s.server.close();
  });

  it("answers with the triage JSON and every meta field", async () => {
    const res = await post(s.url, { text: TICKET, ticket_id: "T-1" }, ACME);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ category: "refund", priority: "high" });
    expect(body.meta).toMatchObject({ prompt_version: "v2", model: "mock-triage-1", provider: "mock", fallback: false, git_sha: gitSha() });
    const meta = body.meta as Record<string, unknown>;
    expect(meta.request_id).toBe(res.headers.get("x-request-id"));
    expect(typeof meta.latency_ms).toBe("number");
  });

  it("401 without a key, and with a wrong one", async () => {
    for (const key of [undefined, "dsp_wrong"]) {
      const res = await post(s.url, { text: TICKET }, key);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { class: "unauthorized" } });
    }
  });

  it("413 over 4,000 characters", async () => {
    const res = await post(s.url, { text: "a".repeat(5000) }, ACME);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { class: "too_large" } });
  });

  it("400 for {}, blank text, an unknown key, and broken JSON", async () => {
    for (const body of [{}, { text: "   " }, { text: "hi", priority: "high" }, "{not json"]) {
      const res = await post(s.url, body, ACME);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { class: "bad_request" } });
    }
  });

  it("404 as typed JSON for an unknown path", async () => {
    const res = await fetch(`${s.url}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { class: "not_found" } });
  });

  it("logs one JSON line per request, with the client name but never the text or key", async () => {
    const before = s.logs.lines.length;
    await post(s.url, { text: TICKET }, ACME);
    await new Promise((r) => setTimeout(r, 20));
    const lines = s.logs.lines.slice(before).filter((l) => l.event === "request");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ client: "acme", status: 200, error_class: null, prompt_version: "v2", provider: "mock" });
    const all = JSON.stringify(s.logs.lines);
    expect(all).not.toContain("charged twice");
    expect(all).not.toContain("jane@example.com");
    expect(all).not.toContain(ACME);
    expect(all).not.toContain(hashKey(ACME));
  });
});

describe("rate limit", () => {
  it("request 61 gets 429 with Retry-After; another client still works", async () => {
    const s = await serve();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 61; i++) statuses.push((await post(s.url, { text: TICKET }, ACME)).status);
      expect(statuses.slice(0, 60).every((x) => x === 200)).toBe(true);
      const last = await post(s.url, { text: TICKET }, ACME);
      expect(last.status).toBe(429);
      expect(last.headers.get("retry-after")).toBe("42");
      expect(await last.json()).toMatchObject({ error: { class: "rate_limit" } });
      expect((await post(s.url, { text: TICKET }, BETA)).status).toBe(200);
    } finally {
      s.server.close();
    }
  });

  it("rounds Retry-After up and never says 0", () => {
    expect(retryAfterSeconds(10_100, 10_000)).toBe(1);
    expect(retryAfterSeconds(10_000, 10_000)).toBe(1);
    expect(retryAfterSeconds(13_001, 10_000)).toBe(4);
  });
});

describe("failures from the model", () => {
  const meta = { prompt_version: "v2", provider: "mock" as const, model: "mock-triage-1", git_sha: "x", fallback: false, retries: 0, repaired: false, tokens_in: 1, tokens_out: 1, latency_ms: 1, cached: false };

  it("a broken answer is a 502 schema_fail, with the raw answer kept out", async () => {
    const broken: TriageResult = { ok: false, error: { class: "schema_fail", message: "bad" }, raw: "SECRET-ECHO", ...meta };
    const s = await serve({ triage: () => Promise.resolve(broken) });
    try {
      const res = await post(s.url, { text: TICKET }, ACME);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: { class: "schema_fail" } });
      expect(text).not.toContain("SECRET-ECHO");
    } finally {
      s.server.close();
    }
  });

  it("a provider failure keeps the gateway's class: a timeout is a 504 timeout in the response and the log", async () => {
    const s = await serve({ triage: () => Promise.reject(new ProviderError("timeout", "gemini did not answer", "gemini")) });
    try {
      const res = await post(s.url, { text: TICKET }, ACME);
      expect(res.status).toBe(504);
      expect(await res.json()).toMatchObject({ error: { class: "timeout" } });
      await new Promise((r) => setTimeout(r, 20));
      expect(s.logs.lines.find((l) => l.event === "request")).toMatchObject({ error_class: "timeout", provider: "gemini" });
    } finally {
      s.server.close();
    }
  });

  it("an unexpected error is a 500 with no stack trace in the response", async () => {
    const s = await serve({ triage: () => Promise.reject(new Error("boom at /app/src/thing.ts:12")) });
    try {
      const res = await post(s.url, { text: TICKET }, ACME);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: { class: "internal" } });
      expect(text).not.toContain("boom");
    } finally {
      s.server.close();
    }
  });
});

describe("through the gateway, on the mocks", () => {
  it("a dead primary is answered by the fallback: meta.fallback is true and the log has 3 primary attempts", async () => {
    const s = await serve({}, { mock: { mode: "500" } });
    try {
      const res = await post(s.url, { text: TICKET }, ACME);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { meta: Record<string, unknown> };
      expect(body.meta).toMatchObject({ provider: "mock_fallback", fallback: true });
      const attempts = s.logs.lines.filter((l) => l.event === "gateway.attempt");
      const requestId = res.headers.get("x-request-id");
      expect(attempts.map((l) => [l.provider, l.attempt, l.decision])).toEqual([
        ["mock", 1, "retry"],
        ["mock", 2, "retry"],
        ["mock", 3, "fallback"],
        ["mock_fallback", 1, "success"],
      ]);
      for (const l of attempts) expect(l.request_id).toBe(requestId);
    } finally {
      s.server.close();
    }
  });

  it("an answer still broken after its repair is a 502 schema_fail", async () => {
    const s = await serve({}, { mock: { mode: "bad_json" } });
    try {
      const res = await post(s.url, { text: TICKET }, ACME);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: { class: "schema_fail" } });
    } finally {
      s.server.close();
    }
  });
});

describe("health", () => {
  it("/readyz names the failing check with a 503; /healthz stays 200", async () => {
    const s = await serve({
      readiness: { config: () => Promise.resolve(), redis: () => Promise.reject(new Error("Redis is not reachable: WRONGPASS")) },
    });
    try {
      const ready = await fetch(`${s.url}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: "not_ready", failing: ["redis"], checks: { config: "ok" } });
      expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
    } finally {
      s.server.close();
    }
  });

  it("/readyz is 200 when every check passes", async () => {
    const s = await serve();
    try {
      const ready = await fetch(`${s.url}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: "ready", git_sha: gitSha(), checks: { config: "ok", redis: "ok" } });
    } finally {
      s.server.close();
    }
  });
});

describe("client keys", () => {
  it("finds the client by key and refuses an unknown one", () => {
    expect(clientForKey(clients, ACME)).toBe("acme");
    expect(clientForKey(clients, "nope")).toBeUndefined();
  });
  it("rejects a malformed list without echoing the hash", () => {
    expect(() => parseClientKeys("acme:abc")).toThrow(/64 hex/);
    expect(() => parseClientKeys(`acme:${hashKey("a")},acme:${hashKey("b")}`)).toThrow(/twice/);
    expect(() => parseClientKeys("")).toThrow(/no clients/);
  });
});

describe("service config", () => {
  const good = {
    DISPATCH_CLIENT_KEYS: `acme:${hashKey(ACME)}`,
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "t",
  };
  it("parses a good environment with defaults", () => {
    expect(parseServiceConfig(good)).toMatchObject({ port: 3000, logLevel: "info", provider: undefined });
  });
  it("names every missing or empty variable and where to put it", () => {
    expect(() => parseServiceConfig({ ...good, UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: undefined })).toThrow(
      /UPSTASH_REDIS_REST_URL is not set[\s\S]*UPSTASH_REDIS_REST_TOKEN is not set[\s\S]*\.env/,
    );
  });
  it("names a bad provider", () => {
    expect(() => parseServiceConfig({ ...good, DISPATCH_PROVIDER: "groq" })).toThrow(/DISPATCH_PROVIDER is invalid/);
  });
});

describe("release config", () => {
  it("reads the stable version and refuses anything else", () => {
    expect(parseReleaseConfig("stable: v2\n")).toEqual({ stable: "v2" });
    expect(() => parseReleaseConfig("stable: two\n")).toThrow(/invalid/);
    expect(() => parseReleaseConfig("stable: v2\ncanary: v3\n")).toThrow(/invalid/);
  });
});
