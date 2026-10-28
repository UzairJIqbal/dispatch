// Tracing: one OpenTelemetry tracer for the process, exporting to Langfuse
// over OTLP/HTTP. Every span is about timings, labels, tokens and error
// classes; ticket text only goes in with the local debug capture on, and then
// redacted (see redact()).
//
// Attribute names follow the OpenTelemetry GenAI semantic conventions at
// open-telemetry/semantic-conventions-genai commit 51a0f58 (2026-10-27), still
// marked Development. Ours are under `app.`; Langfuse's own under `langfuse.`.
import { context, createContextKey, ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Context, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { gitSha } from "../env.js";
import type { TracingConfig } from "./config.js";

export const SEMCONV_GENAI = "open-telemetry/semantic-conventions-genai@51a0f58 (2026-10-27, Development)";

const SERVICE = "dispatch";

type ExportResult = Parameters<Parameters<SpanExporter["export"]>[1]>[0];
// ExportResultCode.SUCCESS is 0. The enum lives in @opentelemetry/core, which
// is only here as the exporter's own dependency, so the value is written out.
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
const EXPORT_SUCCESS: ExportResult["code"] = 0;

/** A warning for the person running the process: one line, never a key. */
export type Warn = (message: string) => void;

export type TracingSetup = {
  config: TracingConfig;
  warn: Warn;
  /** Tests: export here instead of Langfuse, one span at a time. */
  exporter?: SpanExporter;
};

export type Tracing = {
  /** Sends what's pending. The eval calls it before exiting. */
  flush(): Promise<void>;
  /** Flushes and stops. Called once, on shutdown. */
  shutdown(): Promise<void>;
};

let provider: TracerProvider | undefined;
let capture = false;
let contextReady = false;

/** The tracer. Before setupTracing() it makes non-recording spans, so code that traces runs the same untraced. */
export function tracer(): Tracer {
  return provider?.getTracer(SERVICE) ?? trace.getTracer(SERVICE);
}

/** Whether the local debug capture is on: only then does (redacted) text go into spans. */
export function captureOn(): boolean {
  return capture;
}

// Attributes every span under a root carries, so Langfuse can filter any
// observation by them (session, release, prompt version) without a join.
const CARRIED = createContextKey("dispatch.carried_attributes");

// Only startRoot() writes this key, always with an Attributes object.
const isAttributes = (v: unknown): v is Attributes => typeof v === "object" && v !== null;

class CarryProcessor implements SpanProcessor {
  onStart(span: Parameters<SpanProcessor["onStart"]>[0], parent: Context): void {
    const carried = parent.getValue(CARRIED);
    if (isAttributes(carried)) span.setAttributes(carried);
  }
  onEnd(): void {
    // Nothing: this only adds attributes at the start.
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Wraps the real exporter so a dead Langfuse or a wrong key costs one warning
 * line, not one per batch. Spans are dropped; requests never wait on it.
 * After a success, a later failure warns again.
 */
export class WarnOnceExporter implements SpanExporter {
  private warned = false;
  constructor(
    private readonly inner: SpanExporter,
    private readonly warn: Warn,
  ) {}
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code === EXPORT_SUCCESS) this.warned = false;
      else if (!this.warned) {
        this.warned = true;
        // The exporter's error is the HTTP status and Langfuse's reply, never our headers.
        const why = result.error?.message.split("\n")[0] ?? "unknown error";
        // Outside any request: the batch was sent from whichever request's
        // context scheduled it, and the warning isn't about that request.
        context.with(ROOT_CONTEXT, () => {
          this.warn(`tracing: spans could not be sent to Langfuse (${why}). Requests are unaffected. Check LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL in .env.`);
        });
      }
      done(result);
    });
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

function langfuseExporter(config: TracingConfig, warn: Warn): SpanExporter | undefined {
  const lf = config.langfuse;
  if (!lf) {
    warn(
      "tracing: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are not set, so traces are not sent anywhere. " +
        "Add both, and LANGFUSE_BASE_URL, to .env (Langfuse → your project → Settings → API Keys).",
    );
    return undefined;
  }
  return new WarnOnceExporter(
    new OTLPTraceExporter({
      url: `${lf.baseUrl}/api/public/otel/v1/traces`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${lf.publicKey}:${lf.secretKey}`).toString("base64")}`,
        // Real-time ingestion: a trace shows up in seconds, not minutes.
        "x-langfuse-ingestion-version": "4",
      },
      timeoutMillis: 5_000,
    }),
    warn,
  );
}

/** Sets tracing up for the process. Calling it again replaces the setup (tests do). */
export function setupTracing(setup: TracingSetup): Tracing {
  if (!contextReady) {
    // Carries the active span across awaits, so a model attempt finds its request.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    contextReady = true;
  }
  const { config, warn } = setup;
  capture = config.captureContent;

  const exporter = setup.exporter ?? langfuseExporter(config, warn);
  const processors: SpanProcessor[] = [new CarryProcessor()];
  // Batched for real use: an export never sits on a request's path.
  if (exporter) processors.push(setup.exporter ? new SimpleSpanProcessor({ exporter }) : new BatchSpanProcessor({ exporter }));

  provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": SERVICE, "service.version": gitSha() }),
    // A request's children follow its root: a trace is kept whole or not at all.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
    spanProcessors: processors,
  });
  const mine = provider;
  return {
    flush: () => mine.forceFlush(),
    shutdown: () => mine.shutdown(),
  };
}

/**
 * Starts a trace's root span. `carried` goes on it and on every span under it.
 * The root is never a child of whatever is active: each request is its own trace.
 */
export function startRoot(name: string, options: SpanOptions, carried: Attributes): { span: Span; ctx: Context } {
  const base = context.active().setValue(CARRIED, carried);
  const span = tracer().startSpan(name, { ...options, root: true }, base);
  return { span, ctx: trace.setSpan(base, span) };
}

/** The trace id for logs and responses. */
export function traceId(span: Span | undefined): string | undefined {
  const id = span?.spanContext().traceId;
  return id && id !== "00000000000000000000000000000000" ? id : undefined;
}

/** For pino's `mixin`: the active trace's id on every log line written inside a request. */
export function traceMixin(): { trace_id?: string } {
  const id = traceId(trace.getActiveSpan());
  return id ? { trace_id: id } : {};
}

/**
 * A decision the gateway made, recorded twice: as an event on the active span
 * (OpenTelemetry's way) and as a zero-length child observation, because
 * Langfuse doesn't draw span events on its timeline.
 */
export function decision(name: string, attributes: Attributes): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
  tracer()
    .startSpan(name, { attributes: { ...attributes, "langfuse.observation.type": "event" } })
    .end();
}

/** Ends a span as failed with one of our error classes. */
export function failSpan(span: Span, errorClass: string): void {
  span.setAttributes({ "app.error_class": errorClass, "error.type": errorClass });
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorClass });
}

// Debug capture only. Over-redacting is fine; missing one is not. Emails go
// first, so a phone-like run of digits inside one doesn't split it.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Seven or more digits, with the separators people type: +92 300 1234567,
// (021) 555-0100, 0300-1234567.
const PHONE = /[+(]?\d(?:[\s().-]*\d){6,}/g;

export function redact(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

/**
 * The trace's output in Langfuse's table: the labels, which may leave the
 * process (the summary may not: it can echo the ticket). The debug capture,
 * when on, replaces it with the whole answer.
 */
export function labelsOut(span: Span, labels: { category: string; priority: string }): void {
  span.setAttribute("langfuse.observation.output", JSON.stringify({ category: labels.category, priority: labels.priority }));
}

/** Sets a span's input and output for the debug capture, redacted. A no-op when capture is off. */
export function captureIO(span: Span, io: { input?: string; output?: string }): void {
  if (!capture) return;
  if (io.input !== undefined) span.setAttribute("langfuse.observation.input", redact(io.input));
  if (io.output !== undefined) span.setAttribute("langfuse.observation.output", redact(io.output));
}
