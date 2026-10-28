import { z } from "zod";
import { ProviderNameSchema } from "../gateway/config.js";
import { parseClientKeys, type ClientKeys } from "./clients.js";

// Everything the service reads from the environment. Checked once at startup:
// a bad or missing value stops the process with the variable's name.

// `FOO=` in .env arrives as "", which means "not set", not "set to empty".
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
const required = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

const EnvSchema = z.object({
  PORT: optional(z.coerce.number().int().min(1).max(65_535)),
  LOG_LEVEL: optional(z.enum(["debug", "info", "warn", "error"])),
  DISPATCH_CLIENT_KEYS: required(z.string()),
  UPSTASH_REDIS_REST_URL: required(z.url({ protocol: /^https$/, message: "must be the https:// REST URL from the Upstash console" })),
  UPSTASH_REDIS_REST_TOKEN: required(z.string()),
  /** Overrides the prompt's model alias. `pnpm dev` and docker compose default it to mock. */
  DISPATCH_PROVIDER: optional(ProviderNameSchema),
  /** Basic auth on /metrics. Unset: open, which is right only on a private network (docker compose). */
  METRICS_PASSWORD: optional(z.string().min(16, "use at least 16 characters, e.g. from `openssl rand -hex 16`")),
});

export type ServiceConfig = {
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  clients: ClientKeys;
  redis: { url: string; token: string };
  provider: z.infer<typeof ProviderNameSchema> | undefined;
  metricsPassword: string | undefined;
};

const HINTS: Record<string, string> = {
  DISPATCH_CLIENT_KEYS: "Make a key with `pnpm client-key <name>` and paste the name:hash line it prints.",
  UPSTASH_REDIS_REST_URL: "Upstash console → your database → REST API → UPSTASH_REDIS_REST_URL.",
  UPSTASH_REDIS_REST_TOKEN: "Upstash console → your database → REST API → UPSTASH_REDIS_REST_TOKEN.",
  DISPATCH_PROVIDER: "One of gemini, cohere, mock; or leave it unset to use the prompt's model alias.",
};

export function parseServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const name = String(issue.path[0]);
      const what = env[name] === undefined || env[name] === "" ? "is not set" : `is invalid: ${issue.message}`;
      return `- ${name} ${what}. ${HINTS[name] ?? ""}`.trimEnd();
    });
    throw new Error(`The service can't start:\n${lines.join("\n")}\nSet these in .env in the repo root (every variable is listed in .env.example).`);
  }
  const e = parsed.data;
  let clients: ClientKeys;
  try {
    clients = parseClientKeys(e.DISPATCH_CLIENT_KEYS);
  } catch (err) {
    throw new Error(`The service can't start:\n- DISPATCH_CLIENT_KEYS is invalid: ${err instanceof Error ? err.message : String(err)} ${HINTS.DISPATCH_CLIENT_KEYS ?? ""}`, { cause: err });
  }
  return {
    port: e.PORT ?? 3000,
    logLevel: e.LOG_LEVEL ?? "info",
    clients,
    redis: { url: e.UPSTASH_REDIS_REST_URL, token: e.UPSTASH_REDIS_REST_TOKEN },
    provider: e.DISPATCH_PROVIDER,
    metricsPassword: e.METRICS_PASSWORD,
  };
}
