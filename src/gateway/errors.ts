// Every failure has one of these classes, and every log, response and (later)
// metric and trace uses the same names.
export const ERROR_CLASSES = ["rate_limit", "timeout", "provider_5xx", "connection", "bad_request", "auth", "schema_fail", "circuit_open"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

// Worth another try on the same provider: the next attempt can succeed. A
// bad_request or auth error fails the same way every time, so retrying only
// burns quota.
export const RETRYABLE: ReadonlySet<ErrorClass> = new Set(["rate_limit", "timeout", "provider_5xx", "connection"]);

/** A provider call that failed. The message never contains a key or ticket text. */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  constructor(
    readonly errorClass: ErrorClass,
    message: string,
    readonly provider: string,
    /** HTTP status, when the provider answered at all. */
    readonly status?: number,
    /** Seconds the provider asked us to wait, from Retry-After. */
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}
