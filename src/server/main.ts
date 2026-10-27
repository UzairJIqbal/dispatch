import type { Server } from "node:http";
import { Redis } from "@upstash/redis";
import { pino } from "pino";
import { gitSha, loadEnv } from "../env.js";
import { loadModelsConfig, resolveChain } from "../gateway/config.js";
import { Gateway } from "../gateway/gateway.js";
import { loadReleaseConfig } from "../release/config.js";
import { loadPrompt } from "../triage/prompt.js";
import { triage } from "../triage/triage.js";
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
  const chain = resolveChain(models, prompt.model, config.provider);

  const log = pino({
    level: config.logLevel,
    base: { service: "dispatch", git_sha: gitSha() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Belt and braces: nothing should ever log these, but if it does they're blanked.
    redact: { paths: ["text", "*.text", "authorization", "*.authorization", "headers", "*.headers"], censor: "[redacted]" },
  });

  const gateway = new Gateway({ config: models, log });
  // Makes every provider in the chain now, which fails here, naming the
  // variable, if the primary's or the fallback's key is missing.
  gateway.prepare(prompt.model, config.provider);

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
    triage: (text, { log: requestLog }) => triage(text, release.stable, { gateway, log: requestLog, ...(config.provider ? { provider: config.provider } : {}) }),
    readiness: {
      config: () => Promise.resolve(),
      redis: async () => {
        try {
          await withTimeout(redis.ping(), REDIS_PING_TIMEOUT_MS, "Redis");
        } catch (err) {
          throw new Error(`Redis is not reachable: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      },
      // Not ready when a key is missing or every provider's circuit is open:
      // a load balancer should send traffic elsewhere until one recovers.
      providers: () => {
        const problem = gateway.notReady(prompt.model, config.provider);
        return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
      },
    },
    log,
    isShuttingDown: () => shuttingDown,
  });

  const server: Server = app.listen(config.port, () => {
    log.info(
      { event: "startup", port: config.port, prompt_version: prompt.version, chain: chain.map((m) => `${m.provider}/${m.model}`), clients: config.clients.size },
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
