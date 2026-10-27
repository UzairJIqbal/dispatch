import type { ErrorClass } from "../gateway/errors.js";

// The classes a client can see, each with one status code. The first group is
// about the client's own request; the second is the gateway's classes, so a
// response, its log line and (later) its metric all use the same name.
export const HTTP_ERRORS = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  too_large: 413,
  rate_limit: 429,
  internal: 500,
} as const;
export type ClientErrorClass = keyof typeof HTTP_ERRORS;

// A gateway failure is ours, never the client's: a provider's 429 or 400 is
// not something the caller did. The provider was out of reach (503), too slow
// (504), or answered with something we can't use (502).
export const GATEWAY_STATUS: Readonly<Record<ErrorClass, number>> = {
  rate_limit: 503,
  provider_5xx: 503,
  connection: 503,
  auth: 503,
  circuit_open: 503,
  timeout: 504,
  schema_fail: 502,
  bad_request: 502,
};

export type HttpErrorClass = ClientErrorClass | ErrorClass;

export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly errorClass: HttpErrorClass;
  readonly status: number;
  /** A client class by name, or `{ gateway: class }` for a gateway failure (its status comes from GATEWAY_STATUS). */
  constructor(
    cls: ClientErrorClass | { gateway: ErrorClass },
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    if (typeof cls === "string") {
      this.errorClass = cls;
      this.status = HTTP_ERRORS[cls];
    } else {
      this.errorClass = cls.gateway;
      this.status = GATEWAY_STATUS[cls.gateway];
    }
  }
}
