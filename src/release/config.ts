import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { paths, rel } from "../paths.js";
import { loadPrompt, PromptVersionSchema } from "../triage/prompt.js";

// Which prompt versions are live. The live copy is in Upstash Redis, so a
// release is a config change, never a rebuild; config/release.yaml is the
// default when Redis has nothing (a fresh database, a local run).

/** Rollback criteria, written before a canary starts. Percentages are 0-100. */
export const CriteriaSchema = z.strictObject({
  /** Canary requests needed before any verdict: fewer is noise. */
  min_requests: z.number().int().min(1),
  /** Roll back when canary p95 > this × stable p95. */
  p95_ratio: z.number().gt(1),
  /** Roll back when canary error rate > stable error rate + this many points. */
  error_rate_points: z.number().min(0).max(100),
  /** Roll back when the canary's schema-valid rate is below this. */
  schema_valid_min: z.number().min(0).max(100),
  /** How far back each check looks. */
  window_minutes: z.number().int().min(1).max(60),
});
export type Criteria = z.infer<typeof CriteriaSchema>;

/** The spec's numbers: what `pnpm release set-criteria` writes when given none. */
export const DEFAULT_CRITERIA: Criteria = { min_requests: 50, p95_ratio: 1.25, error_rate_points: 2, schema_valid_min: 95, window_minutes: 10 };

// Above 50% the "canary" is most of the traffic: that's a promote.
export const MAX_CANARY_WEIGHT = 50;
export const CanarySchema = z.strictObject({
  version: PromptVersionSchema,
  /** Percent of requests, 1-50. */
  weight: z.number().int().min(1).max(MAX_CANARY_WEIGHT),
});

export const ReleaseConfigSchema = z
  .strictObject({
    stable: PromptVersionSchema,
    canary: CanarySchema.nullable().default(null),
    criteria: CriteriaSchema.nullable().default(null),
    /**
     * Skip the primary provider: every request starts on the fallback. The
     * runbook's switch for a primary that is down or slow, flipped in Redis
     * with no deploy.
     */
    force_fallback: z.boolean().default(false),
  })
  // Criteria first: a canary with nothing to judge it by can't be rolled back automatically.
  .refine((c) => c.canary === null || c.criteria !== null, { message: "a canary needs criteria: run `pnpm release set-criteria` first", path: ["criteria"] })
  .refine((c) => c.canary?.version !== c.stable, { message: "the canary can't be the stable version", path: ["canary", "version"] });
export type ReleaseConfig = z.infer<typeof ReleaseConfigSchema>;

/** The release file (YAML). */
export function parseReleaseConfig(text: string, file = rel(paths.release)): ReleaseConfig {
  const parsed = ReleaseConfigSchema.safeParse(parse(text));
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The copy in Redis (JSON). Throws with what's wrong; the caller decides whether that's fatal. */
export function parseStoredRelease(raw: string, key: string): ReleaseConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Redis key ${key} is not JSON.`);
  }
  const parsed = ReleaseConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Redis key ${key} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * Always written in the same shape and key order, so two equal configs are
 * equal strings. `force_fallback` is written only while it is on: images
 * from before the switch read the key strictly and would reject it, and
 * every config written before it stays the same string.
 */
export function serializeRelease(c: ReleaseConfig): string {
  return JSON.stringify({
    stable: c.stable,
    canary: c.canary ? { version: c.canary.version, weight: c.canary.weight } : null,
    criteria: c.criteria,
    ...(c.force_fallback ? { force_fallback: true } : {}),
  });
}

/** Where the live copy lives. The prefix keeps staging and production apart in one database. */
export function releaseKey(prefix: string): string {
  return `${prefix}:release`;
}

/** Reads the release file and checks the version it names really exists, so a typo fails at startup. */
export function loadReleaseConfig(file = paths.release): ReleaseConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No release config at ${rel(file)}. It needs one line naming the live prompt, e.g. \`stable: v2\`.`);
  }
  const config = parseReleaseConfig(text, rel(file));
  loadPrompt(config.stable);
  if (config.canary) loadPrompt(config.canary.version);
  return config;
}
