import { loadEnv } from "../src/env.js";
import { applyCommand, describeRelease, parseReleaseArgs, ServiceReleaseSchema, type ServiceRelease } from "../src/release/cli.js";
import { readRelease, updateRelease, upstashBackend } from "../src/release/store.js";
import { run } from "./run.js";

// `pnpm release <command> [--target local|staging|prod]`: changes which prompt
// version serves traffic by writing the release config in Upstash Redis. The
// service re-reads it within 30 s. Nothing is built or deployed.
//
// It asks the service itself (GET /readyz) which prompt versions its image
// has and which Redis key it reads, so a version the image doesn't have is
// refused, and staging's config can't be written into production's key.

// Staging scales to zero: the first request after a quiet spell waits for a cold start.
const READY_TIMEOUT_MS = 90_000;

async function askService(url: string): Promise<ServiceRelease> {
  let res: Response;
  try {
    res = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Can't reach ${url}/readyz (${err instanceof Error ? err.message : String(err)}). Start it (\`docker compose up\`, \`pnpm dev\`) or check the URL.`, { cause: err });
  }
  // A 503 still says what the service has; only the release part matters here.
  const body = ServiceReleaseSchema.safeParse(await res.json().catch(() => undefined));
  if (!body.success) throw new Error(`${url}/readyz doesn't say which prompt versions it has: that deployment is older than the canary release. Deploy the current main first.`);
  return body.data;
}

run(async () => {
  loadEnv();
  const args = parseReleaseArgs(process.argv.slice(2), process.env);
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are needed: console.upstash.com → your database → REST API. Put both in .env.");
  }

  const service = await askService(args.url);
  const backend = upstashBackend(redisUrl, token, service.release.key);
  // When Redis has no config yet, the service serves its image's file default.
  const fallback = { stable: service.release.stable, canary: null, criteria: null };
  console.log(`${args.target} (${args.url}, ${service.git_sha}) · Redis key ${backend.key}`);

  if (args.command.name === "status") {
    const { config, source } = await readRelease(backend, fallback);
    console.log(`config    ${describeRelease(config)}${source === "file" ? "\n          (nothing in Redis yet: this is the image's config/release.yaml)" : ""}`);
    const live = service.release;
    console.log(`serving   stable ${live.stable} · canary ${live.canary ? `${live.canary.version} at ${String(live.canary.weight)}%` : "none"} (re-read every 30 s)`);
    console.log(`prompts   ${service.release.prompt_versions.join(", ")} in the image`);
    return;
  }

  const command = args.command;
  const { before, after } = await updateRelease(backend, fallback, (current) => applyCommand(command, current, service.release.prompt_versions));
  console.log(`before    ${describeRelease(before)}`);
  console.log(`after     ${describeRelease(after)}`);
  console.log("\nThe service picks this up within 30 s. Nothing was rebuilt or redeployed.");
});
