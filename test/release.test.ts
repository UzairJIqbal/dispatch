import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/gateway.js";
import { Metrics } from "../src/metrics/metrics.js";
import { applyCommand, parseReleaseArgs } from "../src/release/cli.js";
import { DEFAULT_CRITERIA, ReleaseConfigSchema, parseStoredRelease, serializeRelease, type ReleaseConfig } from "../src/release/config.js";
import { canaryAwareMocks, withRelease } from "../src/release/mock.js";
import { AutoRollback, judge, type Observation } from "../src/release/rollback.js";
import { ReleaseStore, memoryBackend, updateRelease } from "../src/release/store.js";
import { triage } from "../src/triage/triage.js";

const silent = pino({ level: "silent" });

/** Seeded, so the routing test gives the same answer every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CANARY: ReleaseConfig = { stable: "v1", canary: { version: "v2", weight: 10 }, criteria: DEFAULT_CRITERIA, force_fallback: false };

function store(config: ReleaseConfig, backend = memoryBackend("t:release", serializeRelease(config)), now?: () => number) {
  return new ReleaseStore({ backend, fallback: { stable: config.stable, canary: null, criteria: null, force_fallback: false }, checkVersion: () => undefined, log: silent, ...(now ? { now } : {}) });
}

const obs = (release: "stable" | "canary", version: string, n: number, seconds: number, outcome: Observation["outcome"] = "ok"): Observation[] =>
  Array.from({ length: n }, () => ({ t: 0, release, version, seconds, outcome }));

describe("release config", () => {
  it("refuses a canary without criteria, a canary equal to stable, and a weight over 50", () => {
    expect(ReleaseConfigSchema.safeParse({ stable: "v1", canary: { version: "v2", weight: 10 } }).success).toBe(false);
    expect(ReleaseConfigSchema.safeParse({ ...CANARY, canary: { version: "v1", weight: 10 } }).success).toBe(false);
    expect(ReleaseConfigSchema.safeParse({ ...CANARY, canary: { version: "v2", weight: 60 } }).success).toBe(false);
    expect(ReleaseConfigSchema.safeParse(CANARY).success).toBe(true);
  });

  it("reads back what it writes", () => {
    expect(parseStoredRelease(serializeRelease(CANARY), "k")).toEqual(CANARY);
    expect(() => parseStoredRelease("{nope", "k")).toThrow(/not JSON/);
  });
});

describe("routing", () => {
  it("sends the canary its weight's share of 10,000 requests, within a point", async () => {
    const s = store(CANARY);
    await s.refresh();
    const random = mulberry32(42);
    let canary = 0;
    for (let i = 0; i < 10_000; i++) if (s.pick(random).release === "canary") canary++;
    // 10% of 10,000 has a standard deviation of 30: ±100 is more than 3 of them.
    expect(canary).toBeGreaterThan(900);
    expect(canary).toBeLessThan(1100);
  });

  it("sends everything to stable when there is no canary", async () => {
    const s = store({ ...CANARY, canary: null });
    await s.refresh();
    expect(Array.from({ length: 1000 }, () => s.pick().release).every((r) => r === "stable")).toBe(true);
  });

  it("keeps the last good config when Redis holds something invalid", async () => {
    const backend = memoryBackend("t:release", serializeRelease(CANARY));
    const s = store(CANARY, backend);
    await s.refresh();
    backend.value = '{"stable": "two"}';
    await s.refresh();
    expect(s.current()).toEqual(CANARY);
  });

  it("drops a canary this image can't serve and keeps stable", async () => {
    const s = new ReleaseStore({
      backend: memoryBackend("t:release", serializeRelease({ ...CANARY, canary: { version: "v9", weight: 10 } })),
      fallback: { stable: "v1", canary: null, criteria: null, force_fallback: false },
      checkVersion: (v) => {
        if (v === "v9") throw new Error("No prompt prompts/triage/v9.yaml");
      },
      log: silent,
    });
    await s.refresh();
    expect(s.current()).toMatchObject({ stable: "v1", canary: null });
  });
});

describe("rollback criteria", () => {
  const healthy = obs("stable", "v1", 200, 1.5);

  it("judges nothing under 50 canary requests, however bad", () => {
    const v = judge(healthy, obs("canary", "v2", 49, 20, "error"), DEFAULT_CRITERIA);
    expect(v.action).toBe("wait");
  });

  it("keeps a canary as good as stable", () => {
    expect(judge(healthy, obs("canary", "v2", 50, 1.5), DEFAULT_CRITERIA).action).toBe("keep");
  });

  it("rolls back when canary p95 is over 1.25 × stable's", () => {
    const v = judge(healthy, obs("canary", "v2", 50, 1.9), DEFAULT_CRITERIA);
    expect(v.action).toBe("rollback");
    expect(v.reasons).toEqual([expect.stringMatching(/p95 1.9 s > 1.25 × stable p95 1.5 s/)]);
    // 1.25 × 1.5 = 1.875: just under it is fine.
    expect(judge(healthy, obs("canary", "v2", 50, 1.85), DEFAULT_CRITERIA).action).toBe("keep");
  });

  it("rolls back when canary error rate is over stable's + 2 points", () => {
    // 2 of 50 = 4% against stable's 0%.
    const v = judge(healthy, [...obs("canary", "v2", 48, 1.5), ...obs("canary", "v2", 2, 1.5, "error")], DEFAULT_CRITERIA);
    expect(v.action).toBe("rollback");
    expect(v.reasons).toEqual([expect.stringMatching(/error rate 4% > stable 0% \+ 2 points/)]);
    // 1 of 50 = 2%: not over.
    expect(judge(healthy, [...obs("canary", "v2", 49, 1.5), ...obs("canary", "v2", 1, 1.5, "error")], DEFAULT_CRITERIA).action).toBe("keep");
  });

  it("rolls back when canary schema-valid is under 95%", () => {
    // 3 schema failures in 50 = 94% valid. Also a 6% error rate.
    const v = judge(healthy, [...obs("canary", "v2", 47, 1.5), ...obs("canary", "v2", 3, 1.5, "schema_fail")], DEFAULT_CRITERIA);
    expect(v.action).toBe("rollback");
    expect(v.reasons).toContainEqual(expect.stringMatching(/schema-valid 94% < 95%/));
  });

  it("doesn't compare with stable until stable has 50 requests too, but still checks schema-valid", () => {
    const fewStable = obs("stable", "v1", 10, 1.5);
    expect(judge(fewStable, obs("canary", "v2", 50, 9), DEFAULT_CRITERIA).action).toBe("keep");
    expect(judge(fewStable, obs("canary", "v2", 50, 1.5, "schema_fail"), DEFAULT_CRITERIA).action).toBe("rollback");
  });
});

describe("automatic rollback", () => {
  async function setup() {
    let now = 1_000_000;
    const backend = memoryBackend("t:release", serializeRelease(CANARY));
    const lines: Record<string, unknown>[] = [];
    const log = pino({ base: null }, { write: (s: string) => lines.push(JSON.parse(s) as Record<string, unknown>) });
    const s = new ReleaseStore({ backend, fallback: { stable: "v1", canary: null, criteria: null, force_fallback: false }, checkVersion: () => undefined, log, now: () => now });
    await s.refresh();
    const metrics = new Metrics();
    const auto = new AutoRollback({ store: s, backend, log, metrics, now: () => now });
    const feed = (list: Observation[]) => {
      for (const o of list) {
        now += 10;
        auto.observe(o);
      }
    };
    return { backend, s, auto, feed, lines, metrics, advance: (ms: number) => (now += ms) };
  }

  it("sets the canary to none, logs the numbers once and counts it", async () => {
    const { backend, s, auto, feed, lines, metrics } = await setup();
    feed([...obs("stable", "v1", 100, 1.5), ...obs("canary", "v2", 50, 4)]);
    const v = await auto.check();
    expect(v?.action).toBe("rollback");
    expect(parseStoredRelease(backend.value ?? "", "k")).toMatchObject({ stable: "v1", canary: null, criteria: DEFAULT_CRITERIA });
    expect(s.current().canary).toBeNull();
    const events = lines.filter((l) => l.event === "release.rollback");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ canary: "v2", canary_stats: { n: 50, p95_s: 4 }, stable_stats: { n: 100, p95_s: 1.5 } });
    const counter = (await metrics.registry.getMetricsAsJSON()).find((m) => m.name === "dispatch_release_rollbacks_total");
    expect(counter?.values[0]?.value).toBe(1);
    // Nothing left to judge: a second check does nothing.
    expect(await auto.check()).toBeUndefined();
  });

  it("waits for the 50th canary request", async () => {
    const { backend, auto, feed } = await setup();
    feed([...obs("stable", "v1", 100, 1.5), ...obs("canary", "v2", 49, 4)]);
    expect((await auto.check())?.action).toBe("wait");
    expect(parseStoredRelease(backend.value ?? "", "k").canary).not.toBeNull();
    feed(obs("canary", "v2", 1, 4));
    expect((await auto.check())?.action).toBe("rollback");
  });

  it("only looks at the window", async () => {
    const { auto, feed, advance } = await setup();
    feed([...obs("stable", "v1", 100, 1.5), ...obs("canary", "v2", 50, 4)]);
    advance(11 * 60_000);
    expect((await auto.check())?.action).toBe("wait");
  });

  it("doesn't overwrite a release someone changed after the check read it", async () => {
    const { backend, s, auto, feed, lines } = await setup();
    feed([...obs("stable", "v1", 100, 1.5), ...obs("canary", "v2", 50, 4)]);
    // A person promotes v2 between the service's last read and its check.
    await updateRelease(backend, s.current(), (c) => ({ ...c, stable: "v2", canary: null }));
    await auto.check();
    expect(parseStoredRelease(backend.value ?? "", "k")).toMatchObject({ stable: "v2", canary: null });
    expect(lines.some((l) => l.event === "release.rollback_failed")).toBe(true);
  });
});

describe("MOCK_CANARY_MODE", () => {
  it("breaks the mock for canary requests only", async () => {
    const gateway = new Gateway({ mocks: canaryAwareMocks({ mock: {}, mock_fallback: {} }, "500"), log: silent, random: () => 0, metrics: new Metrics() });
    const stable = await withRelease("stable", () => triage("I want a refund", "v2", { gateway, provider: "mock" }));
    const canary = await withRelease("canary", () => triage("I want a refund", "v2", { gateway, provider: "mock" }));
    expect(stable.provider).toBe("mock");
    // The primary mock failed every try, so the fallback answered.
    expect(canary.provider).toBe("mock_fallback");
  });
});

describe("pnpm release", () => {
  const deployed = ["v1", "v2", "v3"];
  const plain: ReleaseConfig = { stable: "v2", canary: null, criteria: DEFAULT_CRITERIA, force_fallback: false };

  it("refuses a version the deployed image doesn't have", () => {
    expect(() => applyCommand({ name: "canary", version: "v9", weight: 10 }, plain, deployed)).toThrow(/Refused: v9 has no prompt file in the deployed image/);
  });

  it("refuses a canary before criteria exist, and a second canary", () => {
    expect(() => applyCommand({ name: "canary", version: "v3", weight: 10 }, { ...plain, criteria: null }, deployed)).toThrow(/no rollback criteria/);
    const running = applyCommand({ name: "canary", version: "v3", weight: 10 }, plain, deployed);
    expect(running.canary).toEqual({ version: "v3", weight: 10 });
    expect(() => applyCommand({ name: "canary", version: "v1", weight: 10 }, running, deployed)).toThrow(/One at a time/);
  });

  it("won't move the criteria while a canary runs", () => {
    const running = applyCommand({ name: "canary", version: "v3", weight: 10 }, plain, deployed);
    expect(() => applyCommand({ name: "set-criteria", criteria: DEFAULT_CRITERIA }, running, deployed)).toThrow(/set before a canary starts/);
  });

  it("promotes and rolls back", () => {
    const running = applyCommand({ name: "canary", version: "v3", weight: 10 }, plain, deployed);
    expect(applyCommand({ name: "promote" }, running, deployed)).toEqual({ stable: "v3", canary: null, criteria: DEFAULT_CRITERIA, force_fallback: false });
    expect(applyCommand({ name: "rollback" }, running, deployed)).toEqual(plain);
    expect(() => applyCommand({ name: "rollback" }, plain, deployed)).toThrow(/no canary/);
  });

  it("turns force-fallback on and off, and stores it only while on", () => {
    const on = applyCommand({ name: "force-fallback", on: true }, plain, deployed);
    expect(on.force_fallback).toBe(true);
    expect(() => applyCommand({ name: "force-fallback", on: true }, on, deployed)).toThrow(/already on/);
    expect(JSON.parse(serializeRelease(on))).toMatchObject({ force_fallback: true });
    // Off writes the same string as before the switch existed, so older images still read it.
    const off = applyCommand({ name: "force-fallback", on: false }, on, deployed);
    expect(serializeRelease(off)).toBe(JSON.stringify({ stable: "v2", canary: null, criteria: DEFAULT_CRITERIA }));
    expect(parseReleaseArgs(["force-fallback", "on"], {}).command).toEqual({ name: "force-fallback", on: true });
    expect(() => parseReleaseArgs(["force-fallback", "maybe"], {})).toThrow(/on or off/);
  });

  it("a store reading force-fallback from Redis sends the next request to the fallback", async () => {
    const backend = memoryBackend("t:release", serializeRelease(plain));
    const s = store(plain, backend);
    await s.refresh();
    expect(s.current().force_fallback).toBe(false);
    await updateRelease(backend, s.current(), (c) => applyCommand({ name: "force-fallback", on: true }, c, deployed));
    await s.refresh();
    const gateway = new Gateway({ mocks: { mock: {}, mock_fallback: {} }, log: silent, random: () => 0, metrics: new Metrics() });
    const r = await triage("I want a refund", "v2", { gateway, provider: "mock", forceFallback: s.current().force_fallback });
    expect(r.provider).toBe("mock_fallback");
  });

  it("reads its arguments and says what's missing", () => {
    expect(parseReleaseArgs(["canary", "v3", "10"], {})).toMatchObject({ command: { name: "canary", version: "v3", weight: 10 }, target: "local", url: "http://localhost:3000" });
    expect(parseReleaseArgs(["set-criteria", "--min-requests", "100"], {}).command).toEqual({ name: "set-criteria", criteria: { ...DEFAULT_CRITERIA, min_requests: 100 } });
    expect(() => parseReleaseArgs(["status", "--target", "staging"], {})).toThrow(/STAGING_URL is not set/);
    expect(() => parseReleaseArgs(["canary", "v3", "0"], {})).toThrow(/whole percent from 1 to 50/);
    expect(() => parseReleaseArgs(["canary", "3", "10"], {})).toThrow(/isn't a prompt version/);
    expect(() => parseReleaseArgs(["deploy"], {})).toThrow(/Unknown command/);
  });
});
