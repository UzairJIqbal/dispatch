import { Redis } from "@upstash/redis";
import type { Logger } from "pino";
import type { Release } from "../metrics/metrics.js";
import { parseStoredRelease, serializeRelease, type ReleaseConfig } from "./config.js";

/** Where the live release config is kept: Upstash in the service and the CLI, memory in tests. */
export interface ReleaseBackend {
  readonly key: string;
  read(): Promise<string | null>;
  /**
   * Writes `next` only if the stored value is still `expected` (null = no key).
   * False when someone else changed it first: the service's auto-rollback and
   * a person running `pnpm release` must never overwrite each other blind.
   */
  write(expected: string | null, next: string): Promise<boolean>;
}

// Compare-and-set in one round trip: Redis runs a script atomically.
const CAS = `local cur = redis.call('GET', KEYS[1])
if (cur == false and ARGV[1] == '') or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

export function upstashBackend(url: string, token: string, key: string): ReleaseBackend {
  // Raw strings in and out: the value is parsed with Zod, not by the client.
  const redis = new Redis({ url, token, retry: false, enableTelemetry: false, automaticDeserialization: false });
  return {
    key,
    async read() {
      const raw: unknown = await redis.get(key);
      if (raw === null) return null;
      if (typeof raw !== "string") throw new Error(`Redis key ${key} is not a string.`);
      return raw;
    },
    async write(expected, next) {
      const done: unknown = await redis.eval(CAS, [key], [expected ?? "", next]);
      return Number(done) === 1;
    },
  };
}

export function memoryBackend(key = "test:release", initial: string | null = null): ReleaseBackend & { value: string | null } {
  const b = {
    key,
    value: initial,
    read: () => Promise.resolve(b.value),
    write(expected: string | null, next: string) {
      if (b.value !== expected) return Promise.resolve(false);
      b.value = next;
      return Promise.resolve(true);
    },
  };
  return b;
}

export type ReadResult = { config: ReleaseConfig; raw: string | null; source: "redis" | "file" };

/** The stored config, or the file default when Redis has none. An invalid stored value throws. */
export async function readRelease(backend: ReleaseBackend, fallback: ReleaseConfig): Promise<ReadResult> {
  const raw = await backend.read();
  if (raw === null) return { config: fallback, raw, source: "file" };
  return { config: parseStoredRelease(raw, backend.key), raw, source: "redis" };
}

/**
 * One release change: read, apply `change`, write only if nobody wrote in
 * between. `change` throws to refuse. A conflict is reported, not retried:
 * whoever is changing the release should look at the new state first.
 */
export async function updateRelease(
  backend: ReleaseBackend,
  fallback: ReleaseConfig,
  change: (current: ReleaseConfig) => ReleaseConfig,
): Promise<{ before: ReleaseConfig; after: ReleaseConfig; source: "redis" | "file" }> {
  const { config: before, raw, source } = await readRelease(backend, fallback);
  const after = change(before);
  if (!(await backend.write(raw, serializeRelease(after)))) {
    throw new Error(`The release config in ${backend.key} changed while this ran (an auto-rollback, or someone else). Nothing was written; run it again.`);
  }
  return { before, after, source };
}

export type ReleasePick = { release: Release; version: string };

export type StoreOptions = {
  backend: ReleaseBackend;
  /** config/release.yaml: used until Redis answers, and whenever Redis has no key. */
  fallback: ReleaseConfig;
  /** Throws when this image can't serve the version (no prompt file, or an invalid one). */
  checkVersion: (version: string) => void;
  log: Logger;
  now?: () => number;
};

/**
 * The service's copy of the release config, re-read from Redis on a timer.
 * When Redis is down or holds something invalid, the last good copy stays: a
 * broken config must never take traffic down, only stop changes arriving.
 */
export class ReleaseStore {
  private config: ReleaseConfig;
  private raw: string | null = null;
  private source: "redis" | "file" = "file";
  /** When this process first saw the current canary. Only requests after it are judged. */
  private canarySince: number;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: StoreOptions) {
    this.now = opts.now ?? Date.now;
    this.config = opts.fallback;
    this.canarySince = this.now();
  }

  get key(): string {
    return this.opts.backend.key;
  }

  current(): ReleaseConfig {
    return this.config;
  }

  info(): { config: ReleaseConfig; source: "redis" | "file"; canarySince: number } {
    return { config: this.config, source: this.source, canarySince: this.canarySince };
  }

  /** Re-reads Redis. Never throws: a failure is logged and the last good copy stays. */
  async refresh(): Promise<void> {
    let read: ReadResult;
    try {
      read = await readRelease(this.opts.backend, this.opts.fallback);
    } catch (err) {
      this.opts.log.error({ event: "release.config_invalid", key: this.key }, `release config not read, keeping ${this.describe(this.config)}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.apply(read);
  }

  /** Applies a config this process just wrote itself (the auto-rollback), without waiting for the next read. */
  applyWritten(config: ReleaseConfig): void {
    this.apply({ config, raw: serializeRelease(config), source: "redis" });
  }

  private apply({ config, raw, source }: ReadResult): void {
    if (raw === this.raw && source === this.source) return;
    // A version this image doesn't have can't be served. A bad stable keeps
    // the whole last good config; a bad canary is dropped and stable carries on.
    let next = config;
    try {
      this.opts.checkVersion(config.stable);
    } catch (err) {
      this.opts.log.error({ event: "release.config_invalid", key: this.key, stable: config.stable }, `stable ${config.stable} can't be served here, keeping ${this.describe(this.config)}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (config.canary) {
      try {
        this.opts.checkVersion(config.canary.version);
      } catch (err) {
        this.opts.log.error({ event: "release.config_invalid", key: this.key, canary: config.canary.version }, `canary ${config.canary.version} can't be served here, sending all traffic to stable: ${err instanceof Error ? err.message : String(err)}`);
        next = { ...config, canary: null };
      }
    }
    const before = this.config;
    this.config = next;
    this.raw = raw;
    this.source = source;
    const sameCanary = before.canary?.version === next.canary?.version && before.canary?.weight === next.canary?.weight;
    if (!sameCanary) this.canarySince = this.now();
    if (serializeRelease(before) !== serializeRelease(next)) {
      this.opts.log.info({ event: "release.change", source, stable: next.stable, canary: next.canary, force_fallback: next.force_fallback, from: { stable: before.stable, canary: before.canary, force_fallback: before.force_fallback } }, `release: ${this.describe(next)}`);
    }
  }

  /** Which release serves one request: the canary with its weight as the chance, else stable. */
  pick(random: () => number = Math.random): ReleasePick {
    const { canary, stable } = this.config;
    if (canary && random() * 100 < canary.weight) return { release: "canary", version: canary.version };
    return { release: "stable", version: stable };
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    // Never the reason the process stays up.
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private describe(c: ReleaseConfig): string {
    const base = c.canary ? `stable ${c.stable}, canary ${c.canary.version} at ${String(c.canary.weight)}%` : `stable ${c.stable}, no canary`;
    return c.force_fallback ? `${base}, primary skipped (force-fallback)` : base;
  }
}
