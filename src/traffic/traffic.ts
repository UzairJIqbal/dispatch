// `pnpm traffic`: steady, made-up load so the dashboard has something to show.
// The pure parts live here so they can be tested without a server.
import { parseArgs } from "node:util";
import { z } from "zod";
import { LIMIT } from "../server/ratelimit.js";

const USAGE = "Usage: pnpm traffic [--rate 1] [--duration 300] [--url http://localhost:3000] [--real]";

// The sliding window lets a key a little under LIMIT a minute in practice
// (the previous minute still counts in part), so each key gets 45.
const PER_KEY_PER_MINUTE = 45;

export type TrafficArgs = {
  /** Requests per second. */
  rate: number;
  /** Seconds; undefined = until Ctrl-C. */
  duration: number | undefined;
  url: string;
  /** Allow a real provider. Without it the first answer must come from a mock. */
  real: boolean;
};

const ArgsSchema = z.strictObject({
  rate: z.coerce.number().positive().max(20, "at most 20 RPS: a load test is Phase 10, with k6").default(1),
  duration: z.coerce.number().int().positive().optional(),
  url: z.url().optional(),
  real: z.boolean().default(false),
});

export function parseTrafficArgs(argv: readonly string[], env: NodeJS.ProcessEnv): TrafficArgs {
  let values: unknown;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { rate: { type: "string" }, duration: { type: "string" }, url: { type: "string" }, real: { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, { cause: err });
  }
  const parsed = ArgsSchema.safeParse(values);
  if (!parsed.success) throw new Error(`${z.prettifyError(parsed.error)}\n${USAGE}`);
  const a = parsed.data;
  return {
    rate: a.rate,
    duration: a.duration,
    url: (a.url ?? `http://localhost:${env.DISPATCH_HOST_PORT ?? "3000"}`).replace(/\/+$/, ""),
    real: a.real,
  };
}

/** How many client keys a rate needs to stay under the per-client limit. */
export function keysNeeded(rate: number): number {
  return Math.ceil((rate * 60) / PER_KEY_PER_MINUTE);
}

/** DISPATCH_TRAFFIC_KEYS: raw client keys, comma-separated, used in turn. */
export function parseTrafficKeys(value: string | undefined, rate: number): string[] {
  const how =
    "Make them with `pnpm client-key traffic` and `pnpm client-key traffic2` (one per 45 requests a minute): " +
    "add each name:hash line to DISPATCH_CLIENT_KEYS, and the keys themselves, comma-separated, to DISPATCH_TRAFFIC_KEYS in .env.";
  const keys = (value ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  if (keys.length === 0) throw new Error(`DISPATCH_TRAFFIC_KEYS is not set. ${how}`);
  const bad = keys.findIndex((k) => !k.startsWith("dsp_"));
  if (bad !== -1) throw new Error(`DISPATCH_TRAFFIC_KEYS entry ${String(bad + 1)} isn't a client key (they start with dsp_). Put the raw keys there, not the name:hash lines.`);
  const need = keysNeeded(rate);
  if (keys.length < need) {
    throw new Error(`${String(rate)} RPS needs ${String(need)} keys in DISPATCH_TRAFFIC_KEYS to stay under the ${String(LIMIT)}-a-minute limit per client; it has ${String(keys.length)}. ${how}`);
  }
  return keys;
}

/** What the script reads from an answer. The service's response is checked, not trusted. */
export const TrafficAnswerSchema = z.object({
  meta: z.object({ provider: z.string(), fallback: z.boolean() }),
});
export const TrafficErrorSchema = z.object({ error: z.object({ class: z.string() }) });

/** Running counts by outcome: "200", "200 fallback", "503 provider_5xx", "unreachable". */
export class Tally {
  private readonly counts = new Map<string, number>();
  private total = 0;

  add(outcome: string): void {
    this.counts.set(outcome, (this.counts.get(outcome) ?? 0) + 1);
    this.total++;
  }

  toString(): string {
    const parts = [...this.counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${String(v)}`);
    return `n=${String(this.total)}  ${parts.join("  ")}`;
  }
}
