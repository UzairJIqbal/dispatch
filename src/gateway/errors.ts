// Every failure has one of these classes, and every metric, log and trace uses
// the same names. `circuit_open` arrives with the gateway in Phase 4.
export const ERROR_CLASSES = ["rate_limit", "timeout", "provider_5xx", "schema_fail", "bad_request", "circuit_open"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

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
