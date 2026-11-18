// `pnpm release`: the pure parts (arguments, refusals, printing), so each
// refusal is tested without Redis or a service.
import { parseArgs } from "node:util";
import { z } from "zod";
import { PromptVersionSchema } from "../triage/prompt.js";
import { CriteriaSchema, DEFAULT_CRITERIA, MAX_CANARY_WEIGHT, ReleaseConfigSchema, type Criteria, type ReleaseConfig } from "./config.js";

export const USAGE = `Usage: pnpm release <command> [--target local|staging|prod]
  status                     what is live, and which prompt versions the service has
  set-criteria [--min-requests 50] [--p95-ratio 1.25] [--error-points 2] [--schema-valid-min 95] [--window-minutes 10]
                             the rollback criteria; needed before any canary
  canary <version> <weight>  send <weight>% of requests to <version> (1-${String(MAX_CANARY_WEIGHT)})
  promote                    the canary becomes stable
  rollback                   stop the canary; every request goes to stable
  force-fallback on|off      on: skip the primary provider, every request starts on the fallback
--target picks the service: local (default, localhost), staging (STAGING_URL) or prod (PROD_URL).`;

export const TARGETS = ["local", "staging", "prod"] as const;
export type Target = (typeof TARGETS)[number];

export type Command =
  | { name: "status" }
  | { name: "canary"; version: string; weight: number }
  | { name: "promote" }
  | { name: "rollback" }
  | { name: "force-fallback"; on: boolean }
  | { name: "set-criteria"; criteria: Criteria };

export type ReleaseArgs = { command: Command; target: Target; url: string };

const TARGET_URL: Readonly<Record<Target, (env: NodeJS.ProcessEnv) => string | undefined>> = {
  local: (env) => `http://localhost:${env.DISPATCH_HOST_PORT ?? "3000"}`,
  staging: (env) => env.STAGING_URL,
  prod: (env) => env.PROD_URL,
};
const TARGET_VAR: Readonly<Record<Target, string>> = { local: "DISPATCH_HOST_PORT", staging: "STAGING_URL", prod: "PROD_URL" };

const fail = (message: string): never => {
  throw new Error(`${message}\n\n${USAGE}`);
};

export function parseReleaseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ReleaseArgs {
  const options = {
    target: { type: "string" },
    "min-requests": { type: "string" },
    "p95-ratio": { type: "string" },
    "error-points": { type: "string" },
    "schema-valid-min": { type: "string" },
    "window-minutes": { type: "string" },
  } as const;
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options, strict: true, allowPositionals: true });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  const target = z.enum(TARGETS).safeParse(values.target ?? "local");
  if (!target.success) return fail(`--target must be one of ${TARGETS.join(", ")}.`);
  const url = TARGET_URL[target.data](env);
  if (!url) return fail(`${TARGET_VAR[target.data]} is not set. Add the ${target.data} app's URL to .env, e.g. ${TARGET_VAR[target.data]}=https://dispatch-${target.data}.<region>.azurecontainerapps.io`);

  const [name, ...rest] = positionals;
  const criteriaFlags = ["min-requests", "p95-ratio", "error-points", "schema-valid-min", "window-minutes"] as const;
  if (name !== "set-criteria" && criteriaFlags.some((f) => values[f] !== undefined)) return fail("The criteria flags go with set-criteria only.");
  const noMore = () => {
    if (rest.length > 0) fail(`${String(name)} takes no arguments.`);
  };

  let command: Command;
  switch (name) {
    case "status":
    case "promote":
    case "rollback":
      noMore();
      command = { name };
      break;
    case "canary": {
      const [version, weight, ...extra] = rest;
      if (!version || !weight || extra.length > 0) return fail("canary needs a version and a weight, e.g. `pnpm release canary v3 10`.");
      const v = PromptVersionSchema.safeParse(version);
      if (!v.success) return fail(`${version} isn't a prompt version (v1, v2, ...).`);
      const w = Number(weight);
      if (!Number.isInteger(w) || w < 1 || w > MAX_CANARY_WEIGHT) return fail(`The weight is a whole percent from 1 to ${String(MAX_CANARY_WEIGHT)}; got ${weight}.`);
      command = { name, version: v.data, weight: w };
      break;
    }
    case "force-fallback": {
      const [state, ...extra] = rest;
      if ((state !== "on" && state !== "off") || extra.length > 0) return fail("force-fallback takes on or off, e.g. `pnpm release force-fallback on --target staging`.");
      command = { name, on: state === "on" };
      break;
    }
    case "set-criteria": {
      noMore();
      const num = (flag: (typeof criteriaFlags)[number], fallback: number) => (values[flag] === undefined ? fallback : Number(values[flag]));
      const c = CriteriaSchema.safeParse({
        min_requests: num("min-requests", DEFAULT_CRITERIA.min_requests),
        p95_ratio: num("p95-ratio", DEFAULT_CRITERIA.p95_ratio),
        error_rate_points: num("error-points", DEFAULT_CRITERIA.error_rate_points),
        schema_valid_min: num("schema-valid-min", DEFAULT_CRITERIA.schema_valid_min),
        window_minutes: num("window-minutes", DEFAULT_CRITERIA.window_minutes),
      });
      if (!c.success) return fail(`Those criteria don't work:\n${z.prettifyError(c.error)}`);
      command = { name, criteria: c.data };
      break;
    }
    case undefined:
      return fail("Which command?");
    default:
      return fail(`Unknown command ${name}.`);
  }
  return { command, target: target.data, url: url.replace(/\/+$/, "") };
}

/** What `pnpm release` reads from the service's /readyz: the image's prompt versions and where its release config lives. */
export const ServiceReleaseSchema = z.object({
  git_sha: z.string(),
  release: z.object({
    key: z.string().min(1),
    source: z.enum(["redis", "file"]),
    stable: PromptVersionSchema,
    canary: z.object({ version: PromptVersionSchema, weight: z.number() }).nullable(),
    // Missing from images older than the switch: they can't skip the primary.
    force_fallback: z.boolean().optional(),
    prompt_versions: z.array(PromptVersionSchema),
  }),
});
export type ServiceRelease = z.infer<typeof ServiceReleaseSchema>;

/**
 * The config after `command`, or a thrown refusal saying why not. `deployed`
 * is the prompt versions in the service's image: a version must be there.
 */
export function applyCommand(command: Command, current: ReleaseConfig, deployed: readonly string[]): ReleaseConfig {
  const refuse = (why: string): never => {
    throw new Error(`Refused: ${why}`);
  };
  let next: ReleaseConfig;
  switch (command.name) {
    case "status":
      return current;
    case "set-criteria":
      // Written before the canary starts, never moved while one runs.
      if (current.canary) return refuse(`canary ${current.canary.version} is running. Criteria are set before a canary starts; promote or roll back first.`);
      next = { ...current, criteria: command.criteria };
      break;
    case "canary":
      if (!deployed.includes(command.version)) return refuse(`${command.version} has no prompt file in the deployed image. It has ${deployed.join(", ") || "none"}. Merge and deploy the prompt first; a release never builds anything.`);
      if (command.version === current.stable) return refuse(`${command.version} is already stable.`);
      if (!current.criteria) return refuse("no rollback criteria yet. Write them first: `pnpm release set-criteria` (the defaults are the spec's).");
      if (current.canary) return refuse(`canary ${current.canary.version} is already running at ${String(current.canary.weight)}%. One at a time: promote or roll back first.`);
      next = { ...current, canary: { version: command.version, weight: command.weight } };
      break;
    case "promote":
      if (!current.canary) return refuse("there is no canary to promote.");
      if (!deployed.includes(current.canary.version)) return refuse(`${current.canary.version} has no prompt file in the deployed image.`);
      next = { ...current, stable: current.canary.version, canary: null };
      break;
    case "rollback":
      if (!current.canary) return refuse("there is no canary to roll back.");
      next = { ...current, canary: null };
      break;
    case "force-fallback":
      if (current.force_fallback === command.on) return refuse(`force-fallback is already ${command.on ? "on" : "off"}.`);
      next = { ...current, force_fallback: command.on };
      break;
  }
  // The same rules the service reads it with.
  return ReleaseConfigSchema.parse(next);
}

export function describeRelease(c: ReleaseConfig): string {
  const canary = c.canary ? `${c.canary.version} at ${String(c.canary.weight)}%` : "none";
  const k = c.criteria;
  const criteria = k
    ? `after ${String(k.min_requests)} canary requests, roll back if p95 > ${String(k.p95_ratio)}× stable, errors > stable + ${String(k.error_rate_points)} pts, or schema-valid < ${String(k.schema_valid_min)}% (last ${String(k.window_minutes)} min)`
    : "none";
  const primary = c.force_fallback ? " · FORCE-FALLBACK ON (primary skipped)" : "";
  return `stable ${c.stable} · canary ${canary}${primary}\n          criteria: ${criteria}`;
}
