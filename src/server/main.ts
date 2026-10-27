import type { Server } from "node:http";
import { Redis } from "@upstash/redis";
import { pino } from "pino";
import { gitSha, loadEnv } from "../env.js";
import { loadModelsConfig, resolveModel } from "../gateway/config.js";
import { loadReleaseConfig } from "../release/config.js";
import { loadPrompt } from "../triage/prompt.js";
import { Gateway, triage } from "../triage/triage.js";
import { createApp } from "./app.js";
import { parseServiceConfig } from "./config.js";
import { upstashLimiter } from "./ratelimit.js";

// How long in-flight requests get to finish after SIGTERM before we exit anyway.
// Below docker compose's stop_grace_period, so we exit before being killed.
const DRAIN_MS = 15_000;
const REDIS_PING_TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} did not answer within ${String(ms)} ms`));
    }, ms);
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

function start(): void {
  loadEnv();
  // Everything that can be wrong with config is found here, before listening.
  const config = parseServiceConfig(process.env);
  const release = loadReleaseConfig();
  const prompt = loadPrompt(release.stable);
  const models = loadModelsConfig();
  const resolved = resolveModel(models, prompt.model, config.provider);
  const gateway = new Gateway();
  // Makes the provider now, which fails here, naming the variable, if its key is missing.
  gateway.provider(resolved.provider);

  const log = pino({
    level: config.logLevel,
    base: { service: "dispatch", git_sha: gitSha() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Belt and braces: nothing should ever log these, but if it does they're blanked.
    redact: { paths: ["text", "*.text", "authorization", "*.authorization", "headers", "*.headers"], censor: "[redacted]" },
  });

  const redis = new Redis({
    url: config.redis.url,
    token: config.redis.token,
    // Retries would turn a dead Redis into a slow /readyz; one answer is enough.
    retry: false,
    enableTelemetry: false,
  });

  let shuttingDown = false;
  const app = createApp({
    clients: config.clients,
    limiter: upstashLimiter(redis, log),
    promptVersion: release.stable,
    triage: (text) => triage(text, release.stable, { gateway, ...(config.provider ? { provider: config.provider } : {}) }),
    readiness: {
      config: () => Promise.resolve(),
      redis: async () => {
        try {
          await withTimeout(redis.ping(), REDIS_PING_TIMEOUT_MS, "Redis");
        } catch (err) {
          throw new Error(`Redis is not reachable: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      },
      providers: () => {
        const keyEnv = resolved.provider === "mock" ? undefined : models.providers[resolved.provider].key_env;
        if (keyEnv && !process.env[keyEnv]) return Promise.reject(new Error(`${keyEnv} is not set`));
        return Promise.resolve();
      },
    },
    log,
    isShuttingDown: () => shuttingDown,
  });

  const server: Server = app.listen(config.port, () => {
    log.info(
      { event: "startup", port: config.port, prompt_version: prompt.version, provider: resolved.provider, model: resolved.model, clients: config.clients.size },
      `dispatch listening on :${String(config.port)}`,
    );
    if (gitSha() === "unknown") log.warn({ event: "startup.no_git_sha" }, "git_sha is unknown: build the image with GIT_SHA=$(git rev-parse --short HEAD)");
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then exit. A second signal, or the drain timeout, exits at once.
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      log.warn({ event: "shutdown.forced", signal }, "second signal: exiting now");
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ event: "shutdown.start", signal }, "shutting down: finishing in-flight requests");
    server.close(() => {
      log.info({ event: "shutdown.done" }, "all requests finished");
      process.exit(0);
    });
    // Idle keep-alive connections would otherwise hold close() open.
    server.closeIdleConnections();
    setTimeout(() => {
      log.warn({ event: "shutdown.timeout", drain_ms: DRAIN_MS }, "requests still in flight after the drain timeout: exiting");
      process.exit(1);
    }, DRAIN_MS).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

try {
  start();
} catch (err) {
  // Plain text, not JSON: this is for the person starting the service.
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
