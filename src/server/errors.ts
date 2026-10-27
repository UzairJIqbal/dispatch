import type { ErrorClass } from "../gateway/errors.js";

// The classes a client can see, each with one status code. The gateway's own
// classes (rate_limit, timeout, provider_5xx, ...) stay in the logs; a client
// only needs to know the provider side failed.
export const HTTP_ERRORS = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  too_large: 413,
  rate_limit: 429,
  internal: 500,
  schema_fail: 502,
  provider_error: 503,
} as const;
export type HttpErrorClass = keyof typeof HTTP_ERRORS;

export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  constructor(
    readonly errorClass: HttpErrorClass,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
    /** The gateway's class behind a provider_error, for the log line. */
    readonly cause_class?: ErrorClass,
  ) {
    super(message);
    this.status = HTTP_ERRORS[errorClass];
  }
}
