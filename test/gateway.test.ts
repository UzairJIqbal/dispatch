// Every reliability behaviour of the gateway, on the in-process mocks: zero
// network, zero real calls. Fake timers stand in for every wait, so a 30 s
// circuit or a 20 s deadline takes no real time.
import { readFileSync } from "node:fs";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseCache } from "../src/gateway/cache.js";
import { Circuit, type CircuitChange } from "../src/gateway/circuit.js";
import { parseModelsConfig, type ModelsConfig } from "../src/gateway/config.js";
import { ProviderError } from "../src/gateway/errors.js";
import { Gateway, type GatewayRequest, type GatewayResult } from "../src/gateway/gateway.js";
import { mockSetupFromEnv, type MockOptions } from "../src/gateway/mock.js";
import { parseRetryAfter } from "../src/gateway/providers.js";
import { paths } from "../src/paths.js";
import { parseAnswer } from "../src/triage/triage.js";
import type { TriageAnswer } from "../src/triage/schema.js";

const baseConfig = parseModelsConfig(readFileSync(paths.models, "utf8"));
type Line = Record<string, unknown>;

/**
 * A gateway on the two mocks, with its log lines captured. `random` is 1, so
 * a backoff wait is always its maximum: 500 ms, then 1000 ms.
 */
function setup(mock: MockOptions = {}, fallback: MockOptions = {}, config: ModelsConfig = baseConfig) {
  const lines: Line[] = [];
  const log = pino({ base: null, timestamp: false }, { write: (s: string) => lines.push(JSON.parse(s) as Line) });
  const gateway = new Gateway({ config, mocks: { mock, mock_fallback: fallback }, log, random: () => 1 });
  const request = (extra: Partial<GatewayRequest<TriageAnswer>> = {}): GatewayRequest<TriageAnswer> => ({
    alias: "mock",
    system: "You triage tickets.",
    user: "<ticket>\nI want a refund\n</ticket>",
    temperature: 0,
    maxTokens: 100,
    validate: (raw) => {
      const p = parseAnswer(raw);
      return p.ok ? { ok: true, value: p.answer } : p;
    },
    ...extra,
  });
  const attempts = (provider?: string) => lines.filter((l) => l.event === "gateway.attempt" && (provider === undefined || l.provider === provider));
  return { gateway, lines, attempts, request };
}

type Outcome = { result: GatewayResult<TriageAnswer>; error?: never; ms: number } | { result?: never; error: ProviderError; ms: number };

/** Runs one call to the end, moving the fake clock through every wait. */
async function run(gateway: Gateway, req: GatewayRequest<TriageAnswer>): Promise<Outcome> {
  const started = Date.now();
  const settled = gateway.call(req).then(
    (result) => ({ result }),
    (err: unknown) => {
      if (!(err instanceof ProviderError)) throw err;
      return { error: err };
    },
  );
  await vi.runAllTimersAsync();
  const o = await settled;
  return { ...o, ms: Date.now() - started };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("success and the error classes", () => {
  it("a healthy primary answers in one attempt", async () => {
    const { gateway, request, attempts } = setup();
    const o = await run(gateway, request());
    expect(o.result).toMatchObject({ ok: true, provider: "mock", fallback: false, retries: 0, repaired: false, cached: false });
    expect(attempts().map((l) => l.decision)).toEqual(["success"]);
  });

  it("a 400 is called exactly once: never retried, and the fallback gets its one try", async () => {
    const { gateway, request, attempts } = setup({ mode: "400" });
    const o = await run(gateway, request());
    expect(attempts("mock")).toMatchObject([{ attempt: 1, error_class: "bad_request", wait_ms: null, decision: "fallback" }]);
    expect(o.result).toMatchObject({ ok: true, provider: "mock_fallback", fallback: true, retries: 0 });
  });

  it("a 400 on every provider: each called exactly once, then bad_request", async () => {
    const { gateway, request, attempts } = setup({ mode: "400" }, { mode: "400" });
    const o = await run(gateway, request());
    expect(o.error?.errorClass).toBe("bad_request");
    expect(attempts().map((l) => [l.provider, l.attempt, l.decision])).toEqual([
      ["mock", 1, "fallback"],
      ["mock_fallback", 1, "give_up"],
    ]);
  });

  it("a fault of ours is not blamed on the provider", async () => {
    const { gateway, request, attempts } = setup();
    const settled = gateway.call(request({ validate: () => { throw new Error("bug in our code"); } })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ message: "bug in our code" });
    expect(attempts()).toHaveLength(0);
    expect(gateway.circuit("mock").current()).toBe("closed");
  });

  it("a wrong key is auth: not retried, and the fallback answers", async () => {
    const { gateway, request, attempts } = setup({ mode: "401" });
    const o = await run(gateway, request());
    expect(attempts("mock")).toMatchObject([{ error_class: "auth", decision: "fallback" }]);
    expect(o.result).toMatchObject({ ok: true, provider: "mock_fallback", fallback: true, retries: 0 });
  });

  it("Gemini's 400 for a wrong key is auth too, so the fallback answers", async () => {
    const { gateway, request, attempts } = setup({ mode: "400_key" });
    const o = await run(gateway, request());
    expect(attempts("mock")).toMatchObject([{ error_class: "auth", decision: "fallback" }]);
    expect(o.result).toMatchObject({ ok: true, provider: "mock_fallback", fallback: true });
  });

  it("a 500 is provider_5xx: 3 attempts with backoff, then the fallback", async () => {
    const { gateway, request, attempts } = setup({ mode: "500" });
    const o = await run(gateway, request());
    expect(attempts("mock").map((l) => [l.attempt, l.error_class, l.wait_ms, l.decision])).toEqual([
      [1, "provider_5xx", 500, "retry"],
      [2, "provider_5xx", 1000, "retry"],
      [3, "provider_5xx", null, "fallback"],
    ]);
    expect(o.result).toMatchObject({ ok: true, provider: "mock_fallback", fallback: true, retries: 2 });
  });

  it("an unreachable host is connection, and is retried", async () => {
    const { gateway, request, attempts } = setup({ mode: ["connection", "ok"] });
    const o = await run(gateway, request());
    expect(attempts("mock").map((l) => [l.error_class, l.decision])).toEqual([
      ["connection", "retry"],
      [null, "success"],
    ]);
    expect(o.result).toMatchObject({ provider: "mock", fallback: false, retries: 1 });
  });

  it("a 429 is rate_limit and is retried", async () => {
    const { gateway, request, attempts } = setup({ mode: ["429", "ok"] });
    const o = await run(gateway, request());
    expect(attempts("mock")[0]).toMatchObject({ error_class: "rate_limit", decision: "retry", wait_ms: 500 });
    expect(o.result?.retries).toBe(1);
  });

  it("when every provider fails, the last real error is thrown", async () => {
    const { gateway, request, attempts } = setup({ mode: "500" }, { mode: "500" });
    const o = await run(gateway, request());
    expect(o.error?.errorClass).toBe("provider_5xx");
    expect(attempts().at(-1)).toMatchObject({ provider: "mock_fallback", attempt: 3, decision: "give_up" });
  });
});

describe("backoff, Retry-After and the deadline", () => {
  it("full jitter: the wait is random between 0 and min(cap, base x 2^retry)", async () => {
    const lines: Line[] = [];
    const log = pino({ base: null }, { write: (s: string) => lines.push(JSON.parse(s) as Line) });
    const gateway = new Gateway({ config: baseConfig, mocks: { mock: { mode: "500" }, mock_fallback: {} }, log, random: () => 0.5 });
    await run(gateway, setup().request());
    expect(lines.filter((l) => l.decision === "retry").map((l) => l.wait_ms)).toEqual([250, 500]);
  });

  it("the backoff never goes over the cap", async () => {
    const config = { ...baseConfig, gateway: { ...baseConfig.gateway, max_retries: 4, backoff_cap_ms: 1500, deadline_ms: 60_000 } };
    const { gateway, request, attempts } = setup({ mode: "500" }, {}, config);
    await run(gateway, request());
    expect(attempts("mock").map((l) => l.wait_ms)).toEqual([500, 1000, 1500, 1500, null]);
  });

  it("honours Retry-After: a 2 s wait before the retry", async () => {
    const { gateway, request, attempts } = setup({ mode: ["429", "ok"], retryAfterS: 2 });
    const o = await run(gateway, request());
    expect(attempts("mock")[0]).toMatchObject({ error_class: "rate_limit", wait_ms: 2000, decision: "retry" });
    expect(o.ms).toBeGreaterThanOrEqual(2000);
    expect(o.result).toMatchObject({ provider: "mock", retries: 1 });
  });

  it("a Retry-After that would pass the deadline falls back now, without waiting", async () => {
    const { gateway, request, attempts } = setup({ mode: "429", retryAfterS: 60 });
    const o = await run(gateway, request());
    expect(attempts("mock")).toMatchObject([{ error_class: "rate_limit", wait_ms: 60_000, decision: "fallback" }]);
    expect(o.result).toMatchObject({ provider: "mock_fallback", fallback: true });
    expect(o.ms).toBeLessThan(1000);
  });

  it("a hung primary is cancelled in time for the fallback to answer", async () => {
    const { gateway, request, attempts } = setup({ mode: "hang" });
    const o = await run(gateway, request());
    // A real hang: held against the provider.
    expect(attempts("mock")[0]?.reason).toBeUndefined();
    expect(attempts("mock")).toMatchObject([{ error_class: "timeout", decision: "fallback" }]);
    expect(o.result).toMatchObject({ ok: true, provider: "mock_fallback", fallback: true });
    expect(o.ms).toBeLessThanOrEqual(10_000);
  });

  it("everything hung: the request ends at the 20 s deadline with timeout", async () => {
    const { gateway, request, attempts } = setup({ mode: "hang" }, { mode: "hang" });
    const o = await run(gateway, request());
    expect(o.error?.errorClass).toBe("timeout");
    expect(o.ms).toBeLessThanOrEqual(20_000);
    expect(attempts().map((l) => [l.provider, l.error_class, l.decision])).toEqual([
      ["mock", "timeout", "fallback"],
      ["mock_fallback", "timeout", "give_up"],
    ]);
  });

  it("an answer slower than the attempt timeout is cut off as a timeout", async () => {
    const { gateway, request, attempts } = setup({ delayMs: 12_000 });
    const o = await run(gateway, request());
    expect(attempts("mock")).toMatchObject([{ error_class: "timeout", decision: "fallback" }]);
    expect(o.result).toMatchObject({ ok: true, provider: "mock_fallback" });
    expect(o.ms).toBeLessThanOrEqual(20_000);
  });

  it("slow answers, at a real provider's pace", async () => {
    const { gateway, request } = setup({ mode: "slow" });
    const o = await run(gateway, request());
    expect(o.result).toMatchObject({ ok: true, provider: "mock" });
    expect(o.ms).toBeGreaterThan(0);
  });

  it("waiting for a free-tier slot isn't counted against the deadline or the latency", async () => {
    // 6 calls a minute: the second call waits 11 s in the pacer.
    const config = { ...baseConfig, providers: { ...baseConfig.providers, mock: { ...baseConfig.providers.mock, rpm: 6 } } };
    const { gateway, request } = setup({ mode: "ok" }, {}, config);
    await run(gateway, request());
    const second = await run(gateway, request());
    expect(second.ms).toBeGreaterThanOrEqual(11_000);
    expect(second.result).toMatchObject({ ok: true, provider: "mock" });
    expect(second.result?.latencyMs).toBeLessThan(1000);
  });
});

describe("repair", () => {
  it("bad_json_once: one repair, then a valid answer", async () => {
    const { gateway, request, attempts } = setup({ mode: "bad_json_once" });
    const o = await run(gateway, request());
    expect(o.result).toMatchObject({ ok: true, repaired: true, retries: 0, fallback: false });
    expect(attempts("mock").map((l) => [l.error_class, l.decision, l.repair ?? false])).toEqual([
      ["schema_fail", "repair", false],
      [null, "success", true],
    ]);
  });

  it("bad_json: repaired once, still broken, schema_fail. Never passed on, never sent to the fallback", async () => {
    const { gateway, request, attempts } = setup({ mode: "bad_json" });
    const o = await run(gateway, request());
    expect(o.result?.ok).toBe(false);
    expect(o.result).toMatchObject({ repaired: true, provider: "mock" });
    expect(attempts("mock")).toHaveLength(2);
    expect(attempts("mock_fallback")).toHaveLength(0);
  });

  it("repairs once per request, even when the repair call fails and is retried", async () => {
    const { gateway, request, attempts } = setup({ mode: ["bad_json", "500", "bad_json"] });
    const o = await run(gateway, request());
    expect(attempts("mock").map((l) => [l.attempt, l.error_class, l.decision])).toEqual([
      [1, "schema_fail", "repair"],
      [1, "provider_5xx", "retry"],
      [2, "schema_fail", "give_up"],
    ]);
    // The retry re-sent the repair, not the original prompt.
    expect(attempts("mock").at(-1)).toMatchObject({ repair: true });
    expect(o.result).toMatchObject({ ok: false, repaired: true });
  });

  it("a retried repair call can still succeed", async () => {
    const { gateway, request, attempts } = setup({ mode: ["bad_json", "500", "ok"] });
    const o = await run(gateway, request());
    expect(attempts("mock").at(-1)).toMatchObject({ attempt: 2, repair: true, decision: "success" });
    expect(o.result).toMatchObject({ ok: true, repaired: true, retries: 1, provider: "mock" });
  });

  it("the fallback's broken answer gets its own repair", async () => {
    const { gateway, request, attempts } = setup({ mode: ["bad_json", "500"] }, { mode: "bad_json_once" });
    const o = await run(gateway, request());
    expect(attempts("mock_fallback").map((l) => [l.error_class, l.decision])).toEqual([
      ["schema_fail", "repair"],
      [null, "success"],
    ]);
    expect(o.result).toMatchObject({ ok: true, repaired: true, provider: "mock_fallback" });
  });

  it("the repair is cached under its own key: a rerun is served entirely from the cache", async () => {
    const cache = new ResponseCache(":memory:");
    const parts = { promptVersion: "v1", promptSha256: "x", temperature: 0, maxTokens: 100, text: "I want a refund" };
    const { gateway, request } = setup({ mode: "bad_json_once" });
    const first = await run(gateway, request({ cache: { store: cache, parts, refresh: false } }));
    const second = await run(gateway, request({ cache: { store: cache, parts, refresh: false } }));
    cache.close();
    expect(first.result).toMatchObject({ ok: true, repaired: true, cached: false });
    expect(second.result).toMatchObject({ ok: true, repaired: true, cached: true });
  });
});

describe("the circuit breaker", () => {
  const cfg = baseConfig.gateway.circuit;
  function circuit() {
    let now = 0;
    const changes: CircuitChange[] = [];
    const c = new Circuit(cfg, (ch) => changes.push(ch), () => now);
    return { c, changes, tick: (ms: number) => (now += ms) };
  }

  it("closed -> open after 5 failures within 30 s", () => {
    const { c, changes } = circuit();
    for (let i = 0; i < 4; i++) c.failure();
    expect(c.current()).toBe("closed");
    c.failure();
    expect(c.current()).toBe("open");
    expect(c.allow()).toBe(false);
    expect(changes).toEqual([{ from: "closed", to: "open" }]);
  });

  it("failures older than the window don't count", () => {
    const { c, tick } = circuit();
    for (let i = 0; i < 4; i++) c.failure();
    tick(cfg.window_ms);
    c.failure();
    expect(c.current()).toBe("closed");
  });

  it("successes in between don't wipe the count: 5 failures within 30 s open it", () => {
    const { c } = circuit();
    for (let i = 0; i < 4; i++) {
      c.failure();
      c.success();
    }
    expect(c.current()).toBe("closed");
    c.failure();
    expect(c.current()).toBe("open");
  });

  it("open -> half_open after 30 s, which lets exactly one trial through", () => {
    const { c, tick } = circuit();
    for (let i = 0; i < 5; i++) c.failure();
    tick(cfg.open_ms - 1);
    expect(c.allow()).toBe(false);
    tick(1);
    expect(c.current()).toBe("half_open");
    expect(c.allow()).toBe(true);
    expect(c.allow()).toBe(false);
  });

  it("half_open -> closed when the trial succeeds", () => {
    const { c, tick, changes } = circuit();
    for (let i = 0; i < 5; i++) c.failure();
    tick(cfg.open_ms);
    c.allow();
    c.success();
    expect(c.current()).toBe("closed");
    expect(changes.map((ch) => ch.to)).toEqual(["open", "half_open", "closed"]);
  });

  it("release frees a half-open trial without a verdict", () => {
    const { c, tick } = circuit();
    for (let i = 0; i < cfg.failures; i++) c.failure();
    tick(cfg.open_ms);
    expect(c.allow()).toBe(true);
    expect(c.allow()).toBe(false);
    c.release();
    expect(c.current()).toBe("half_open");
    expect(c.allow()).toBe(true);
  });

  it("half_open -> open again when the trial fails", () => {
    const { c, tick } = circuit();
    for (let i = 0; i < 5; i++) c.failure();
    tick(cfg.open_ms);
    c.allow();
    c.failure();
    expect(c.current()).toBe("open");
    tick(cfg.open_ms - 1);
    expect(c.allow()).toBe(false);
  });

  it("in the gateway: the 5th failure opens it, later requests skip the primary with no wait, and after 30 s one trial goes through", async () => {
    const primary: MockOptions = { mode: "500" };
    const { gateway, request, attempts, lines } = setup(primary);

    await run(gateway, request()); // 3 failures
    const second = await run(gateway, request()); // 2 more: open; the 3rd attempt is skipped
    expect(lines.find((l) => l.event === "gateway.circuit")).toMatchObject({ provider: "mock", from: "closed", to: "open" });
    expect(attempts("mock")).toHaveLength(5);
    expect(second.result).toMatchObject({ provider: "mock_fallback", fallback: true });

    const third = await run(gateway, request());
    expect(attempts("mock")).toHaveLength(5);
    expect(lines.filter((l) => l.event === "gateway.skip").at(-1)).toMatchObject({ provider: "mock", error_class: "circuit_open", decision: "fallback" });
    expect(third.ms).toBe(0);
    expect(third.result).toMatchObject({ provider: "mock_fallback" });

    // 30 s later the primary has recovered: one trial, it succeeds, the circuit closes.
    primary.mode = "ok";
    vi.advanceTimersByTime(baseConfig.gateway.circuit.open_ms);
    const fourth = await run(gateway, request());
    expect(fourth.result).toMatchObject({ provider: "mock", fallback: false });
    expect(lines.filter((l) => l.event === "gateway.circuit").map((l) => l.to)).toEqual(["open", "half_open", "closed"]);
  });

  it("a failed trial opens it again and the request still gets the fallback", async () => {
    const { gateway, request, attempts, lines } = setup({ mode: "500" });
    await run(gateway, request());
    await run(gateway, request());
    vi.advanceTimersByTime(baseConfig.gateway.circuit.open_ms);
    const o = await run(gateway, request());
    expect(attempts("mock")).toHaveLength(6);
    expect(o.result).toMatchObject({ provider: "mock_fallback" });
    expect(lines.filter((l) => l.event === "gateway.circuit").map((l) => l.to)).toEqual(["open", "half_open", "open"]);
  });

  it("a 400 or a broken answer doesn't count against the provider", async () => {
    const { gateway, request } = setup({ mode: "400" });
    for (let i = 0; i < 6; i++) await run(gateway, request());
    expect(gateway.circuit("mock").current()).toBe("closed");
  });

  it("a cache hit doesn't close a half-open circuit: only a real answer does", async () => {
    const cache = new ResponseCache(":memory:");
    const parts = { promptVersion: "v1", promptSha256: "x", temperature: 0, maxTokens: 100, text: "I want a refund" };
    const primary: MockOptions = { mode: "ok" };
    const { gateway, request } = setup(primary);
    await run(gateway, request({ cache: { store: cache, parts, refresh: false } }));
    primary.mode = "500";
    await run(gateway, request());
    await run(gateway, request());
    vi.advanceTimersByTime(baseConfig.gateway.circuit.open_ms);
    const o = await run(gateway, request({ cache: { store: cache, parts, refresh: false } }));
    cache.close();
    expect(o.result).toMatchObject({ provider: "mock", cached: true });
    expect(gateway.circuit("mock").current()).toBe("half_open");
    // The trial wasn't used up: the next real request still gets it.
    expect(gateway.circuit("mock").allow()).toBe(true);
  });

  it("a fault of ours during a half-open trial frees the trial", async () => {
    const { gateway, request } = setup({ mode: "500" });
    await run(gateway, request());
    await run(gateway, request());
    vi.advanceTimersByTime(baseConfig.gateway.circuit.open_ms);
    // A closed cache throws on read: a fault of ours, before anything is sent.
    const broken = new ResponseCache(":memory:");
    broken.close();
    const parts = { promptVersion: "v1", promptSha256: "x", temperature: 0, maxTokens: 100, text: "I want a refund" };
    const settled = gateway.call(request({ cache: { store: broken, parts, refresh: false } })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await settled).not.toBeInstanceOf(ProviderError);
    expect(gateway.circuit("mock").current()).toBe("half_open");
    expect(gateway.circuit("mock").allow()).toBe(true);
  });

  it("an attempt cut short by our own deadline isn't held against the provider", async () => {
    // Each request: a 429 (counted) asking for 6 s, then a hang with only 4 s
    // of the primary's share left, cut by us (not counted).
    const { gateway, request, attempts } = setup({ mode: ["429", "hang", "429", "hang", "429", "hang"], retryAfterS: 6 });
    for (let i = 0; i < 3; i++) await run(gateway, request());
    expect(attempts("mock").filter((l) => l.reason === "cut by the deadline")).toHaveLength(3);
    expect(gateway.circuit("mock").current()).toBe("closed");
  });

  it("with the fallback's circuit open, the primary gets the whole deadline", async () => {
    const { gateway, request, attempts } = setup({ mode: ["hang", "ok"] });
    for (let i = 0; i < baseConfig.gateway.circuit.failures; i++) gateway.circuit("mock_fallback").failure();
    const o = await run(gateway, request());
    expect(attempts("mock").map((l) => [l.error_class, l.decision])).toEqual([
      ["timeout", "retry"],
      [null, "success"],
    ]);
    expect(o.result).toMatchObject({ ok: true, provider: "mock", retries: 1 });
  });

  it("every circuit open: fails fast with circuit_open, and /readyz says why", async () => {
    const { gateway, request, attempts } = setup({ mode: "500" }, { mode: "500" });
    expect(gateway.notReady("mock")).toBeUndefined();
    await run(gateway, request());
    await run(gateway, request());
    const before = attempts().length;
    const o = await run(gateway, request());
    expect(o.error?.errorClass).toBe("circuit_open");
    expect(o.ms).toBe(0);
    expect(attempts()).toHaveLength(before);
    expect(gateway.notReady("mock")).toMatch(/circuit is open/);
  });
});

describe("small parts", () => {
  it("reads Retry-After as seconds or as an HTTP date", () => {
    const now = Date.parse("2026-10-28T10:00:00Z");
    expect(parseRetryAfter("2", now)).toBe(2);
    expect(parseRetryAfter("Wed, 28 Oct 2026 10:00:05 GMT", now)).toBe(5);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("drill settings come from the environment, and a typo says what's allowed", () => {
    expect(mockSetupFromEnv({ MOCK_MODE: "429", MOCK_RETRY_AFTER: "2" })).toEqual({ mock: { mode: "429", retryAfterS: 2 }, mock_fallback: { retryAfterS: 2 } });
    expect(() => mockSetupFromEnv({ MOCK_MODE: "50O" })).toThrow(/MOCK_MODE is invalid: it must be one of ok, 429, 500/);
  });

  it("the chain is the alias, then its fallback; --provider cohere is Cohere alone", () => {
    const gateway = new Gateway({ config: baseConfig, mocks: { mock: {}, mock_fallback: {} } });
    expect(gateway.chain("mock").map((m) => m.provider)).toEqual(["mock", "mock_fallback"]);
    expect(gateway.chain("fast").map((m) => m.provider)).toEqual(["gemini", "cohere"]);
    expect(gateway.chain("fast", "cohere").map((m) => m.provider)).toEqual(["cohere"]);
  });
});
