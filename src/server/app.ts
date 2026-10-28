import { randomUUID, timingSafeEqual } from "node:crypto";
import { context, SpanKind, SpanStatusCode, type Context, type Span } from "@opentelemetry/api";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import { gitSha } from "../env.js";
import { ProviderNameSchema } from "../gateway/config.js";
import { ProviderError, type ErrorClass } from "../gateway/errors.js";
import { MAX_TICKET_CHARS } from "../golden/schema.js";
import { routeOf, type Metrics } from "../metrics/metrics.js";
import { captureIO, failSpan, labelsOut, startRoot, traceId, tracer } from "../tracing/tracing.js";
import type { TriageResult } from "../triage/triage.js";
import { clientForKey, type ClientKeys } from "./clients.js";
import { HttpError, type HttpErrorClass } from "./errors.js";
import type { Limiter } from "./ratelimit.js";

export type ReadinessCheck = () => Promise<void>;

export type AppDeps = {
  clients: ClientKeys;
  limiter: Limiter;
  /** The prompt version this process serves, for logs when a call fails before answering. */
  promptVersion: string;
  /** The one triage call, bound to the live prompt version and provider. `log` carries the request id. */
  triage: (text: string, ctx: { log: Logger }) => Promise<TriageResult>;
  /** Each throws with the reason it isn't ready. */
  readiness: Readonly<Record<string, ReadinessCheck>>;
  log: Logger;
  isShuttingDown: () => boolean;
  /** The same instance the gateway counts into. */
  metrics: Metrics;
  /** When set, /metrics asks for basic auth (user `metrics`, this password). */
  metricsPassword?: string | undefined;
};

// The request body. Closed, so an unexpected key is a 400, not silently ignored.
// The length cap is checked after, because too long is a 413, not a 400.
const TriageRequestSchema = z.strictObject({
  text: z.string().refine((s) => s.trim().length > 0, "text is empty"),
  ticket_id: z.string().min(1).max(128).optional(),
});

/** What the request's one log line says. Filled in as the request goes. */
type RequestContext = {
  requestId: string;
  started: number;
  client?: string;
  errorClass?: HttpErrorClass;
  promptVersion?: string;
  model?: string;
  provider?: string;
  fallback?: boolean;
  /** The request's root span, on /v1 only: health checks aren't traced. */
  span?: Span;
  /** The context to run the triage in: the root span and what its children carry. */
  traceCtx?: Context;
};

// What a client reads for each gateway failure. Never the provider's own
// message: it can name the model, the account or echo the request.
const GATEWAY_MESSAGES: Readonly<Record<ErrorClass, string>> = {
  rate_limit: "The model providers are rate-limiting us. Try again shortly.",
  provider_5xx: "The model providers failed to answer. Try again shortly.",
  connection: "The model providers could not be reached. Try again shortly.",
  auth: "The service can't authenticate with its model providers. This is on our side.",
  circuit_open: "Every model provider is failing right now, so the request was not sent. Try again in a minute.",
  timeout: "The model did not answer in time.",
  schema_fail: "The model's answer failed validation.",
  bad_request: "The model provider refused the request.",
};

const contexts = new WeakMap<object, RequestContext>();
function ctx(req: object): RequestContext {
  const c = contexts.get(req);
  if (!c) throw new Error("request context missing: the logging middleware must run first");
  return c;
}

function sendError(res: Response, err: HttpError): void {
  for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
  res.status(err.status).json({ error: { class: err.errorClass, message: err.message } });
}

// Body-parser errors carry a `type`. Only these two are the client's fault in a way we name.
const BodyParserErrorSchema = z.object({ type: z.enum(["entity.too.large", "entity.parse.failed"]) });

/** What the root span says once the response is done: the same fields as the request's log line. */
function endRoot(span: Span, c: RequestContext, status: number, aborted: boolean): void {
  span.setAttributes({
    "http.response.status_code": status,
    ...(c.client ? { "app.client": c.client, "langfuse.user.id": c.client } : {}),
    ...(c.promptVersion ? { "app.prompt_version": c.promptVersion } : {}),
    ...(c.model ? { "app.model": c.model } : {}),
    ...(c.provider ? { "app.provider": c.provider } : {}),
    "app.fallback": c.fallback ?? false,
    ...(aborted ? { "app.aborted": true } : {}),
  });
  if (c.errorClass) span.setAttribute("app.error_class", c.errorClass);
  // A 5xx is ours; a 4xx is the client's request and not a failure of the service.
  if (status >= 500) failSpan(span, c.errorClass ?? "internal");
  else if (!c.errorClass) span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

// Constant-time on both the user and the password, so the reply time says nothing about either.
function basicAuthOk(header: string | undefined, password: string): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1], "base64");
  const want = Buffer.from(`metrics:${password}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createApp(deps: AppDeps): express.Express {
  const { log } = deps;
  const app = express();
  app.disable("x-powered-by");

  // One log line per request, written when the response is done. It never
  // holds the ticket text or the key: only what's in RequestContext.
  app.use((req, res, next) => {
    const c: RequestContext = { requestId: randomUUID(), started: performance.now() };
    contexts.set(req, c);
    res.setHeader("X-Request-Id", c.requestId);
    if (req.path === "/v1" || req.path.startsWith("/v1/")) {
      // Started before auth, so a 401 or a 429 has a trace too.
      const root = startRoot(
        "triage.request",
        { kind: SpanKind.SERVER, attributes: { "http.request.method": req.method, "http.route": req.path, "app.request_id": c.requestId } },
        { "langfuse.release": gitSha(), "langfuse.version": deps.promptVersion, "app.prompt_version": deps.promptVersion, "app.release": "stable", "app.git_sha": gitSha() },
      );
      c.span = root.span;
      c.traceCtx = root.ctx;
    }
    // While draining on SIGTERM, tell keep-alive clients not to send more on this connection.
    if (deps.isShuttingDown()) res.setHeader("Connection", "close");
    res.on("close", () => {
      const route = routeOf(req.path);
      deps.metrics.request({ route, status: res.statusCode, errorClass: c.errorClass });
      // The latency SLI: triage requests that got as far as the model call
      // (promptVersion is set once the body is valid), so a client's 4xx
      // never counts as our latency.
      if (route === "/v1/triage" && c.promptVersion && (res.statusCode < 400 || res.statusCode >= 500)) {
        const provider = ProviderNameSchema.safeParse(c.provider);
        deps.metrics.triageLatency({ promptVersion: c.promptVersion, provider: provider.success ? provider.data : "none", release: "stable", seconds: (performance.now() - c.started) / 1000 });
      }
      const tid = traceId(c.span);
      if (c.span) endRoot(c.span, c, res.statusCode, !res.writableFinished);
      log.info(
        {
          event: "request",
          request_id: c.requestId,
          ...(tid ? { trace_id: tid } : {}),
          method: req.method,
          path: req.path,
          client: c.client ?? null,
          status: res.statusCode,
          error_class: c.errorClass ?? null,
          latency_ms: Math.round(performance.now() - c.started),
          prompt_version: c.promptVersion ?? null,
          model: c.model ?? null,
          provider: c.provider ?? null,
          ...(c.fallback ? { fallback: true } : {}),
          ...(res.writableFinished ? {} : { aborted: true }),
        },
        "request",
      );
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    const checks: Record<string, string> = {};
    const failing: string[] = [];
    if (deps.isShuttingDown()) {
      checks.shutdown = "shutting down";
      failing.push("shutdown");
    }
    await Promise.all(
      Object.entries(deps.readiness).map(async ([name, check]) => {
        try {
          await check();
          checks[name] = "ok";
        } catch (err) {
          checks[name] = err instanceof Error ? err.message : String(err);
          failing.push(name);
        }
      }),
    );
    if (failing.length === 0) res.json({ status: "ready", checks });
    else res.status(503).json({ status: "not_ready", failing: failing.sort(), checks });
  });

  // Prometheus scrapes this. Locally (docker compose) it's open on the
  // private network; deployed, METRICS_PASSWORD puts basic auth on it.
  app.get("/metrics", async (req, res) => {
    if (deps.metricsPassword !== undefined && !basicAuthOk(req.get("authorization"), deps.metricsPassword)) {
      throw new HttpError("unauthorized", "Basic auth needed: user `metrics`, password METRICS_PASSWORD.", { "WWW-Authenticate": 'Basic realm="dispatch-metrics"' });
    }
    res.setHeader("Content-Type", deps.metrics.registry.contentType);
    res.send(await deps.metrics.registry.metrics());
  });

  // Auth and the rate limit come before the body is even parsed: an unknown
  // caller gets a 401 whatever they sent.
  app.use("/v1", async (req, _res, next) => {
    const c = ctx(req);
    const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
    const unauthorized = (message: string) => new HttpError("unauthorized", message, { "WWW-Authenticate": 'Bearer realm="dispatch"' });
    if (!match?.[1]) throw unauthorized("Missing client key. Send it as `Authorization: Bearer <key>`.");
    const client = clientForKey(deps.clients, match[1]);
    if (!client) throw unauthorized("Unknown client key.");
    c.client = client;

    // Its own span: the check is a Redis round trip, often the slowest step
    // after the model, and a trace should account for all of a request's time.
    const limit = await tracer().startActiveSpan("ratelimit.check", {}, c.traceCtx ?? context.active(), async (span) => {
      try {
        const r = await deps.limiter.check(client);
        span.setAttribute("app.rate_limited", !r.allowed);
        return r;
      } finally {
        span.end();
      }
    });
    if (!limit.allowed) {
      throw new HttpError("rate_limit", `Over the limit for this client. Try again in ${String(limit.retryAfterS)} s.`, { "Retry-After": String(limit.retryAfterS) });
    }
    next();
  });

  // Generous for 4,000 characters (even all 4-byte UTF-8 with JSON escapes);
  // anything bigger is refused before it's read into memory.
  app.use("/v1", express.json({ limit: "64kb" }));

  app.post("/v1/triage", async (req: Request<unknown, unknown, unknown>, res) => {
    const c = ctx(req);
    const parsed = TriageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // The issue paths and messages only, never the values that came in.
      throw new HttpError("bad_request", `Body must be JSON like {"text": "...", "ticket_id": "optional"}. ${z.prettifyError(parsed.error)}`);
    }
    const { text } = parsed.data;
    if (text.length > MAX_TICKET_CHARS) {
      throw new HttpError("too_large", `text is ${String(text.length)} characters; the limit is ${String(MAX_TICKET_CHARS)}.`);
    }

    c.promptVersion = deps.promptVersion;
    let result: TriageResult;
    try {
      // The span is put back by hand: the body parser's callback loses the async context.
      const run = () => deps.triage(text, { log: log.child({ request_id: c.requestId }) });
      result = c.traceCtx ? await context.with(c.traceCtx, run) : await run();
    } catch (err) {
      if (err instanceof ProviderError) {
        c.provider = err.provider;
        throw new HttpError({ gateway: err.errorClass }, GATEWAY_MESSAGES[err.errorClass]);
      }
      throw err;
    }
    c.promptVersion = result.prompt_version;
    c.model = result.model;
    c.provider = result.provider;
    c.fallback = result.fallback;
    if (c.span && result.ok) labelsOut(c.span, result.answer);
    if (c.span) captureIO(c.span, { input: text, ...(result.ok ? { output: JSON.stringify(result.answer) } : {}) });
    if (!result.ok) {
      // The raw answer stays out of the response and the log: it can echo the ticket.
      throw new HttpError({ gateway: "schema_fail" }, GATEWAY_MESSAGES.schema_fail);
    }
    res.json({
      ...result.answer,
      meta: {
        prompt_version: result.prompt_version,
        model: result.model,
        provider: result.provider,
        fallback: result.fallback,
        git_sha: gitSha(),
        request_id: c.requestId,
        ...(traceId(c.span) ? { trace_id: traceId(c.span) } : {}),
        latency_ms: Math.round(performance.now() - c.started),
      },
    });
  });

  app.use((_req, _res, next) => {
    next(new HttpError("not_found", "No such endpoint. Try POST /v1/triage, GET /healthz, GET /readyz or GET /metrics."));
  });

  // The one error handler. Every failure leaves as { error: { class, message } };
  // a stack trace never does.
  // Express spots an error handler by its four parameters, so `_next` stays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const c = contexts.get(req);
    let httpErr: HttpError;
    if (err instanceof HttpError) httpErr = err;
    else {
      const bodyErr = BodyParserErrorSchema.safeParse(err);
      if (bodyErr.success && bodyErr.data.type === "entity.too.large") httpErr = new HttpError("too_large", "Request body is over 64 KB.");
      else if (bodyErr.success) httpErr = new HttpError("bad_request", "Body is not valid JSON.");
      else {
        // Unexpected: log what it was (never the request body), answer plainly.
        log.error({ event: "error.unexpected", request_id: c?.requestId, trace_id: traceId(c?.span), err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) }, "unexpected error");
        httpErr = new HttpError("internal", "Something went wrong on our side.");
      }
    }
    if (c) c.errorClass = httpErr.errorClass;
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, httpErr);
  });

  return app;
}
