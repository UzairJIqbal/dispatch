import type { Server } from "node:http";
import { Redis } from "@upstash/redis";
import { pino } from "pino";
import { collectDefaultMetrics } from "prom-client";
import { gitSha, loadEnv } from "../env.js";
import { loadModelsConfig, resolveChain } from "../gateway/config.js";
import { Gateway } from "../gateway/gateway.js";
import { mockSetupFromEnv } from "../gateway/mock.js";
import { Metrics } from "../metrics/metrics.js";
import { loadReleaseConfig, releaseKey } from "../release/config.js";
import { canaryAwareMocks, canaryModeFromEnv, withRelease } from "../release/mock.js";
import { AutoRollback } from "../release/rollback.js";
import { ReleaseStore, upstashBackend } from "../release/store.js";
import { parseTracingConfig } from "../tracing/config.js";
import { setupTracing, traceMixin, type Tracing } from "../tracing/tracing.js";
import { loadPrompt, promptVersions } from "../triage/prompt.js";
import { triage } from "../triage/triage.js";
import { createApp } from "./app.js";
import { parseServiceConfig } from "./config.js";
import { unlimited, upstashLimiter } from "./ratelimit.js";

// How long in-flight requests get to finish after SIGTERM before we exit anyway.
// Longer than the gateway's 20 s deadline, so a request in the middle of a
// fallback still finishes; below docker compose's stop_grace_period and
// Container Apps' 30 s grace period, so we exit before being killed.
const DRAIN_MS = 25_000;
const REDIS_PING_TIMEOUT_MS = 2_000;
// Pending spans get this long on exit. Inside the host's 30 s even after a full drain.
const TRACE_FLUSH_MS = 3_000;
// The spec's numbers: a release change reaches every request within 30 s,
// and the canary is judged once a minute.
const RELEASE_REFRESH_MS = 30_000;
const ROLLBACK_CHECK_MS = 60_000;

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

async function start(): Promise<void> {
  loadEnv();
  // Everything that can be wrong with config is found here, before listening.
  const config = parseServiceConfig(process.env);
  // The file is the default until Redis answers, and whenever Redis has no release config.
  const releaseFile = loadReleaseConfig();
  const prompt = loadPrompt(releaseFile.stable);
  const canaryMode = canaryModeFromEnv();
  const models = loadModelsConfig();
  const chain = resolveChain(models, prompt.model, config.provider);

  const log = pino({
    level: config.logLevel,
    base: { service: "dispatch", git_sha: gitSha() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Belt and braces: nothing should ever log these, but if it does they're blanked.
    // The trace id on every line written inside a request, so a log line leads to its trace.
    mixin: traceMixin,
    redact: { paths: ["text", "*.text", "authorization", "*.authorization", "headers", "*.headers"], censor: "[redacted]" },
  });

  const tracing: Tracing = setupTracing({
    config: parseTracingConfig(process.env, (m) => {
      log.warn({ event: "tracing.config" }, m);
    }),
    warn: (m) => {
      log.warn({ event: "tracing.export" }, m);
    },
  });

  const metrics = new Metrics();
  // Node's own: memory, CPU, event-loop lag, GC. Only the service has them; tests and the eval don't.
  collectDefaultMetrics({ register: metrics.registry });
  metrics.priceTable(models.prices.date);

  const gateway = new Gateway({ config: models, log, metrics, mocks: canaryAwareMocks(mockSetupFromEnv(), canaryMode) });
  if (canaryMode) log.warn({ event: "mock.canary_mode", mode: canaryMode }, `MOCK_CANARY_MODE=${canaryMode}: the mock fails on purpose for canary requests only`);
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

  const backend = upstashBackend(config.redis.url, config.redis.token, releaseKey(config.redis.prefix));
  const store = new ReleaseStore({
    backend,
    fallback: releaseFile,
    // A version is servable when its prompt file is in this image and valid,
    // and its model alias resolves to providers whose keys are set.
    checkVersion: (version) => {
      gateway.prepare(loadPrompt(version).model, config.provider);
    },
    log,
  });
  // Before listening, so the first request already follows Redis. If Redis
  // doesn't answer, the file default serves and the timer keeps trying.
  await withTimeout(store.refresh(), REDIS_PING_TIMEOUT_MS, "Redis").catch((err: unknown) => {
    log.warn({ event: "release.startup" }, `release config not read at startup, serving ${releaseFile.stable} from the file: ${err instanceof Error ? err.message : String(err)}`);
  });
  store.start(RELEASE_REFRESH_MS);
  metrics.readCanaryWeight(() => store.current().canary?.weight ?? 0);
  metrics.releaseVersion("stable", store.current().stable);
  const autoRollback = new AutoRollback({ store, backend, log, metrics });
  autoRollback.start(ROLLBACK_CHECK_MS);

  if (config.rateLimit === "off") log.warn({ event: "ratelimit.off" }, "RATE_LIMIT=off: no per-client limit (mock load test only)");

  let shuttingDown = false;
  const app = createApp({
    clients: config.clients,
    limiter: config.rateLimit === "off" ? unlimited : upstashLimiter(redis, log, config.redis.prefix),
    release: () => {
      const pick = store.pick();
      metrics.releaseVersion(pick.release, pick.version);
      return pick;
    },
    triage: (text, { log: requestLog, release, version }) =>
      withRelease(release, () => triage(text, version, { gateway, log: requestLog, ...(config.provider ? { provider: config.provider } : {}) })),
    observe: (o) => {
      autoRollback.observe(o);
    },
    releaseInfo: () => {
      const { config: current, source } = store.info();
      return { stable: current.stable, canary: current.canary, criteria: current.criteria, source, key: store.key, prompt_versions: promptVersions() };
    },
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
        const problem = gateway.notReady(loadPrompt(store.current().stable).model, config.provider);
        return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
      },
    },
    log,
    isShuttingDown: () => shuttingDown,
    metrics,
    metricsPassword: config.metricsPassword,
  });

  const server: Server = app.listen(config.port, () => {
    log.info(
      { event: "startup", port: config.port, prompt_version: store.current().stable, canary: store.current().canary, chain: chain.map((m) => `${m.provider}/${m.model}`), clients: config.clients.size },
      `dispatch listening on :${String(config.port)}`,
    );
    if (gitSha() === "unknown") log.warn({ event: "startup.no_git_sha" }, "git_sha is unknown: build the image with GIT_SHA=$(git rev-parse --short HEAD)");
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then exit. A second signal, or the drain timeout, exits at once.
  // Exits once pending spans are sent, or after TRACE_FLUSH_MS if Langfuse is slow.
  const exit = (code: number) => {
    withTimeout(tracing.shutdown(), TRACE_FLUSH_MS, "Langfuse")
      .catch((err: unknown) => {
        log.warn({ event: "shutdown.trace_flush" }, `pending spans not sent: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => process.exit(code));
  };

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      log.warn({ event: "shutdown.forced", signal }, "second signal: exiting now");
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ event: "shutdown.start", signal }, "shutting down: finishing in-flight requests");
    server.close(() => {
      log.info({ event: "shutdown.done" }, "all requests finished");
      exit(0);
    });
    // Idle keep-alive connections would otherwise hold close() open.
    server.closeIdleConnections();
    setTimeout(() => {
      log.warn({ event: "shutdown.timeout", drain_ms: DRAIN_MS }, "requests still in flight after the drain timeout: exiting");
      exit(1);
    }, DRAIN_MS).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start().catch((err: unknown) => {
  // Plain text, not JSON: this is for the person starting the service.
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
