// Every Prometheus metric the service exposes, in one place, with every label
// it can carry. Labels are only ever values from a small fixed set (a route,
// a status, an error class, a provider): never a ticket id, request id,
// client name, key or text. test/metrics.test.ts lists them all.
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { CircuitState } from "../gateway/circuit.js";
import type { Price, ProviderName } from "../gateway/config.js";
import { ERROR_CLASSES, type ErrorClass } from "../gateway/errors.js";
import { GATEWAY_STATUS, HTTP_ERRORS, type HttpErrorClass } from "../server/errors.js";

/**
 * Seconds. Chosen for an LLM call, not a web page: Gemini's p50 is ~1.5 s and
 * its p95 ~9.6 s (results/baseline.json), and the gateway gives up at 20 s.
 * 4 is an edge on purpose: it is the latency SLO in docs/SLOS.md, so "share
 * of requests under 4 s" is exact, not interpolated.
 */
export const LATENCY_BUCKETS = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20] as const;

/** The routes a request is counted under. Anything else is "other", so a scanner can't add series. */
export const ROUTES = ["/v1/triage", "/healthz", "/readyz", "/metrics", "other"] as const;
export type Route = (typeof ROUTES)[number];

/** Phase 9 adds "canary". Until then every request is the stable release. */
export type Release = "stable";

// 0/1/2 so a panel can colour it and an alert can compare it.
const CIRCUIT_VALUE: Readonly<Record<CircuitState, number>> = { closed: 0, half_open: 1, open: 2 };

export function routeOf(path: string): Route {
  return ROUTES.find((r) => r === path) ?? "other";
}

export class Metrics {
  readonly registry = new Registry();

  /** Every response. `error_class` is "none" on success. */
  private readonly requests = new Counter({
    name: "dispatch_requests_total",
    help: "Responses by route, HTTP status and error class.",
    labelNames: ["route", "status", "error_class"] as const,
    registers: [this.registry],
  });

  /** /v1/triage requests that got to the model call: the latency SLI. Client errors (4xx) aren't in it. */
  private readonly requestDuration = new Histogram({
    name: "dispatch_request_duration_seconds",
    help: "Triage request latency, retries and fallback included.",
    labelNames: ["prompt_version", "provider", "release"] as const,
    buckets: [...LATENCY_BUCKETS],
    registers: [this.registry],
  });

  /** One real call to one provider. Cache hits and waits for a free-tier slot aren't in it. */
  private readonly attemptDuration = new Histogram({
    name: "dispatch_attempt_duration_seconds",
    help: "One provider call, success or failure.",
    labelNames: ["provider"] as const,
    buckets: [...LATENCY_BUCKETS],
    registers: [this.registry],
  });

  /** Failed attempts, skips (circuit open, no time left) and answers still invalid after repair. */
  private readonly gatewayErrors = new Counter({
    name: "dispatch_gateway_errors_total",
    help: "Gateway failures per provider by error class, whether or not the request was saved by a retry or the fallback.",
    labelNames: ["provider", "error_class"] as const,
    registers: [this.registry],
  });

  private readonly tokens = new Counter({
    name: "dispatch_tokens_total",
    help: "Tokens reported by the provider.",
    labelNames: ["provider", "type"] as const,
    registers: [this.registry],
  });

  private readonly cost = new Counter({
    name: "dispatch_cost_usd_total",
    help: "Estimated cost at list price (see dispatch_price_table_info). The free tiers actually cost $0.",
    labelNames: ["provider"] as const,
    registers: [this.registry],
  });

  private readonly fallbacks = new Counter({
    name: "dispatch_fallbacks_total",
    help: "Times a request moved on to the fallback provider.",
    labelNames: ["from", "to"] as const,
    registers: [this.registry],
  });

  private readonly repairs = new Counter({
    name: "dispatch_repairs_total",
    help: "Answers that failed validation and got the one repair retry.",
    labelNames: ["provider"] as const,
    registers: [this.registry],
  });

  private readonly schemaFailures = new Counter({
    name: "dispatch_schema_failures_total",
    help: "Answers still invalid after the repair retry.",
    labelNames: ["provider"] as const,
    registers: [this.registry],
  });

  private circuitReader: () => readonly (readonly [ProviderName, CircuitState])[] = () => [];

  constructor() {
    // Read at scrape time, so it is the circuit's state now, open → half_open included.
    const gauge: Gauge<"provider"> = new Gauge({
      name: "dispatch_circuit_state",
      help: "Circuit breaker per provider: 0 closed, 1 half-open, 2 open.",
      labelNames: ["provider"] as const,
      registers: [this.registry],
      collect: () => {
        for (const [provider, state] of this.circuitReader()) gauge.set({ provider }, CIRCUIT_VALUE[state]);
      },
    });

    // Starts every triage response at 0, so the first failure of a kind is an
    // increase a rate() can see, and the availability panels read 100%, not
    // "no data", before anything has failed.
    this.requests.inc({ route: "/v1/triage", status: "200", error_class: "none" }, 0);
    for (const [cls, status] of Object.entries(GATEWAY_STATUS)) this.requests.inc({ route: "/v1/triage", status: String(status), error_class: cls }, 0);
    this.requests.inc({ route: "/v1/triage", status: String(HTTP_ERRORS.internal), error_class: "internal" }, 0);
  }

  /** The price table's date, as a label: the dashboard shows it next to every cost. */
  priceTable(date: string): void {
    new Gauge({ name: "dispatch_price_table_info", help: "Date of the list-price table the cost estimate uses.", labelNames: ["date"] as const, registers: [this.registry] }).set({ date }, 1);
  }

  /** Where the circuit gauge reads from. The gateway sets it. */
  readCircuits(reader: () => readonly (readonly [ProviderName, CircuitState])[]): void {
    this.circuitReader = reader;
  }

  /** Starts a provider's series at 0, for the same reason as the requests above. */
  provider(provider: ProviderName): void {
    for (const cls of ERROR_CLASSES) this.gatewayErrors.inc({ provider, error_class: cls }, 0);
    this.tokens.inc({ provider, type: "input" }, 0);
    this.tokens.inc({ provider, type: "output" }, 0);
    this.cost.inc({ provider }, 0);
    this.repairs.inc({ provider }, 0);
    this.schemaFailures.inc({ provider }, 0);
  }

  fallbackPair(from: ProviderName, to: ProviderName): void {
    this.fallbacks.inc({ from, to }, 0);
  }

  request(r: { route: Route; status: number; errorClass: HttpErrorClass | undefined }): void {
    this.requests.inc({ route: r.route, status: String(r.status), error_class: r.errorClass ?? "none" });
  }

  triageLatency(r: { promptVersion: string; provider: ProviderName | "none"; release: Release; seconds: number }): void {
    this.requestDuration.observe({ prompt_version: r.promptVersion, provider: r.provider, release: r.release }, r.seconds);
  }

  attempt(provider: ProviderName, seconds: number): void {
    this.attemptDuration.observe({ provider }, seconds);
  }

  gatewayError(provider: ProviderName, errorClass: ErrorClass): void {
    this.gatewayErrors.inc({ provider, error_class: errorClass });
  }

  usage(provider: ProviderName, tokensIn: number, tokensOut: number, price: Price): void {
    this.tokens.inc({ provider, type: "input" }, tokensIn);
    this.tokens.inc({ provider, type: "output" }, tokensOut);
    this.cost.inc({ provider }, (tokensIn * price.input + tokensOut * price.output) / 1_000_000);
  }

  fallback(from: ProviderName, to: ProviderName): void {
    this.fallbacks.inc({ from, to });
  }

  repair(provider: ProviderName): void {
    this.repairs.inc({ provider });
  }

  schemaFailure(provider: ProviderName): void {
    this.schemaFailures.inc({ provider });
    this.gatewayErrors.inc({ provider, error_class: "schema_fail" });
  }
}
