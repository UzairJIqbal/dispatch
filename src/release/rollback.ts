import type { Logger } from "pino";
import type { Metrics, Outcome, Release } from "../metrics/metrics.js";
import type { Criteria } from "./config.js";
import { updateRelease, type ReleaseBackend, type ReleaseStore } from "./store.js";

// The automatic rollback. Every minute it compares the canary with stable
// over the last few minutes of this process's own requests and, if the canary
// breaks a criterion, sets it to none.
//
// It runs in one place only: inside the one service instance. With more
// instances each would judge only its own share and they could race; the way
// to grow is to run the check once (a Redis lock with a short expiry, taken
// before each check, so only its holder judges) and to judge on the summed
// Prometheus series instead of one process's memory. Not built: we run one.

/** A triage request that got as far as the model call. Client errors (4xx) are never in it. */
export type Observation = { t: number; release: Release; version: string; seconds: number; outcome: Outcome };

export type Stats = {
  n: number;
  p95_s: number | null;
  /** Percent of requests that failed, schema failures included. */
  error_rate: number | null;
  /** Percent of answers that passed the schema, of those that came back at all. */
  schema_valid: number | null;
};

export type Verdict = {
  action: "wait" | "keep" | "rollback";
  /** Each broken criterion, with its numbers, in plain words. */
  reasons: string[];
  /** Why there's no verdict yet. */
  waiting?: string;
  stable: Stats;
  canary: Stats;
};

/** Nearest-rank p95: the value 95% of requests were at or under. */
function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null;
}

const round = (x: number | null, digits = 3) => (x === null ? null : Number(x.toFixed(digits)));

export function stats(obs: readonly Observation[]): Stats {
  const n = obs.length;
  const ok = obs.filter((o) => o.outcome === "ok").length;
  const schemaFail = obs.filter((o) => o.outcome === "schema_fail").length;
  return {
    n,
    p95_s: round(p95(obs.map((o) => o.seconds))),
    error_rate: n === 0 ? null : round((100 * (n - ok)) / n, 2),
    schema_valid: ok + schemaFail === 0 ? null : round((100 * ok) / (ok + schemaFail), 2),
  };
}

/**
 * The criteria applied to one window. Pure, so each rule is tested on its own.
 * Nothing is judged under `min_requests` canary requests. The two rules that
 * compare with stable also need that many stable requests, or the comparison
 * is noise; the schema-valid rule needs only the canary.
 */
export function judge(stable: readonly Observation[], canary: readonly Observation[], criteria: Criteria): Verdict {
  const s = stats(stable);
  const c = stats(canary);
  if (c.n < criteria.min_requests) {
    return { action: "wait", reasons: [], waiting: `${String(c.n)} of ${String(criteria.min_requests)} canary requests`, stable: s, canary: c };
  }
  const reasons: string[] = [];
  if (c.schema_valid !== null && c.schema_valid < criteria.schema_valid_min) {
    reasons.push(`canary schema-valid ${String(c.schema_valid)}% < ${String(criteria.schema_valid_min)}%`);
  }
  if (s.n >= criteria.min_requests) {
    if (c.p95_s !== null && s.p95_s !== null && c.p95_s > criteria.p95_ratio * s.p95_s) {
      reasons.push(`canary p95 ${String(c.p95_s)} s > ${String(criteria.p95_ratio)} × stable p95 ${String(s.p95_s)} s`);
    }
    if (c.error_rate !== null && s.error_rate !== null && c.error_rate > s.error_rate + criteria.error_rate_points) {
      reasons.push(`canary error rate ${String(c.error_rate)}% > stable ${String(s.error_rate)}% + ${String(criteria.error_rate_points)} points`);
    }
  }
  const waiting = s.n < criteria.min_requests ? `only ${String(s.n)} stable requests: p95 and error rate not compared yet` : undefined;
  return { action: reasons.length > 0 ? "rollback" : "keep", reasons, ...(waiting ? { waiting } : {}), stable: s, canary: c };
}

// Bounds memory if traffic is far heavier than the window needs. At 20 RPS
// for 10 minutes that's 12,000; the oldest go first.
const MAX_OBSERVATIONS = 50_000;

export type AutoRollbackOptions = {
  store: ReleaseStore;
  backend: ReleaseBackend;
  log: Logger;
  metrics: Metrics;
  now?: () => number;
};

export class AutoRollback {
  private obs: Observation[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: AutoRollbackOptions) {
    this.now = opts.now ?? Date.now;
  }

  observe(o: Omit<Observation, "t">): void {
    this.obs.push({ ...o, t: this.now() });
    if (this.obs.length > MAX_OBSERVATIONS) this.obs.splice(0, this.obs.length - MAX_OBSERVATIONS);
  }

  /** One check. Returns what it decided, for tests and the log. */
  async check(): Promise<Verdict | undefined> {
    const { config, canarySince } = this.opts.store.info();
    const { canary, criteria } = config;
    if (!canary || !criteria) return undefined;
    const from = this.now() - criteria.window_minutes * 60_000;
    this.obs = this.obs.filter((o) => o.t >= from);
    // Only this canary's requests since it started, and stable's over the same window.
    const canaryObs = this.obs.filter((o) => o.release === "canary" && o.version === canary.version && o.t >= canarySince);
    const stableObs = this.obs.filter((o) => o.release === "stable" && o.version === config.stable);
    const verdict = judge(stableObs, canaryObs, criteria);
    if (verdict.action !== "rollback") {
      this.opts.log.debug({ event: "release.check", action: verdict.action, canary: verdict.canary, stable: verdict.stable, ...(verdict.waiting ? { waiting: verdict.waiting } : {}) }, "canary check");
      return verdict;
    }

    let after;
    try {
      // Only if the config is still the canary that was judged: a person may
      // have promoted or rolled back in the meantime.
      ({ after } = await updateRelease(this.opts.backend, config, (cur) => {
        if (cur.canary?.version !== canary.version || cur.canary.weight !== canary.weight) throw new Error("the canary changed since it was judged");
        return { ...cur, canary: null };
      }));
    } catch (err) {
      this.opts.log.error({ event: "release.rollback_failed", canary: canary.version, reasons: verdict.reasons }, `auto-rollback of ${canary.version} not written: ${err instanceof Error ? err.message : String(err)}`);
      return verdict;
    }
    this.opts.store.applyWritten(after);
    this.opts.metrics.rollback();
    this.opts.log.warn(
      {
        event: "release.rollback",
        canary: canary.version,
        weight: canary.weight,
        stable: config.stable,
        reasons: verdict.reasons,
        canary_stats: verdict.canary,
        stable_stats: verdict.stable,
        criteria,
        window_minutes: criteria.window_minutes,
      },
      `auto-rollback: ${canary.version} → none. ${verdict.reasons.join("; ")}`,
    );
    return verdict;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
