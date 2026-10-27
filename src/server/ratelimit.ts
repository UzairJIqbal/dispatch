import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import type { Logger } from "pino";

// 60 requests a minute per client, a sliding window in Upstash. One number,
// not a setting: changing it is a code change that goes through review.
const LIMIT = 60;
const WINDOW = "1 m";

export type LimitResult = { allowed: true } | { allowed: false; retryAfterS: number };

export interface Limiter {
  check(client: string): Promise<LimitResult>;
}

/** Seconds until the window lets the client in again, rounded up, never 0. */
export function retryAfterSeconds(resetMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((resetMs - nowMs) / 1000));
}

export function upstashLimiter(redis: Redis, log: Logger): Limiter {
  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(LIMIT, WINDOW),
    prefix: "dispatch:ratelimit",
    // A slow Redis shouldn't add seconds to every request: after 1.5 s the
    // library lets the request through.
    timeout: 1500,
    analytics: false,
  });
  return {
    async check(client) {
      try {
        const res = await ratelimit.limit(client);
        if (res.reason === "timeout") log.warn({ event: "ratelimit.unavailable", client, reason: "timeout" }, "rate limit skipped: Redis too slow");
        return res.success ? { allowed: true } : { allowed: false, retryAfterS: retryAfterSeconds(res.reset, Date.now()) };
      } catch (err) {
        // Fail open, the same as the library does on a timeout: Redis being
        // down shouldn't take the service down with it. /readyz reports it.
        log.warn({ event: "ratelimit.unavailable", client, reason: err instanceof Error ? err.message : String(err) }, "rate limit skipped: Redis error");
        return { allowed: true };
      }
    },
  };
}
