# Phase 3 — The service

## Goal

`docker compose up` starts Dispatch, and `curl` with a client key gets back a triage answer that says exactly which prompt version, model, provider and git commit produced it.

## Where this starts

`triage()` works from the command line with prompt versions, providers, the mock and the eval. Nothing listens on a port. Create a free Upstash Redis database and put its REST URL and token in `.env`.

## Build

- **Express 5 service** with `POST /v1/triage`. The request body is validated with Zod (`text` 1 to 4,000 characters, optional `ticket_id`). It calls the same `triage()` as the eval.
- **The response**: the triage JSON plus `meta: { prompt_version, model, provider, git_sha, request_id, latency_ms }`.
- **Typed errors** as `{ error: { class, message } }` with the right status code: `bad_request` 400, `unauthorized` 401, `too_large` 413, `rate_limit` 429, `schema_fail` 502, `provider_error` 503. One error handler, no stack traces in responses.
- **Client keys.** An environment variable lists client names with the SHA-256 hash of each key. A missing or wrong key is 401. The client's name, never the key, goes on logs.
- **Per-client rate limit**: a sliding window in Upstash, 60 requests a minute. Over it, 429 with `Retry-After`.
- **Which prompt version is live** comes from a release config file for now (`stable: v2`). The service reads it at startup.
- **`GET /healthz`** (the process is up) and **`GET /readyz`** (config loaded, Redis reachable, provider keys present). `/readyz` returns 503 with the failing check named.
- **Logs** with pino as JSON, one line per request: request id, client name, status, error class, latency, prompt version, provider. Never the ticket text, never a key.
- **Docker**: a multi-stage image, non-root user, the git sha baked in as a build argument. `docker compose up` starts the service with the env file. `.env.example` lists every variable with a one-line comment.
- **`pnpm dev`** runs the service without Docker, on the mock provider by default.

## Constraints

- **One path to the model.** The service calls `triage()`. No second copy.
- **Secrets only from the environment.** Nothing secret in the image, the repo or the logs.
- **The service starts only with valid config.** Bad or missing config fails at startup, naming the variable.
- The response cache is for evals only; the service doesn't use it.
- Graceful shutdown: on SIGTERM, stop taking requests and finish the ones in flight.

## Acceptance check

1. `docker compose up`, then `curl` a ticket with a valid key. The answer has the JSON and every `meta` field, and `git_sha` matches `git rev-parse --short HEAD`.
2. Same request with no key: 401. With text of 5,000 characters: 413. With `{}`: 400. Each as typed JSON.
3. Send 61 requests in a minute with one key (on the mock). Request 61 gets 429 with `Retry-After`. A second key still works.
4. Stop Redis access (wrong token) and call `/readyz`. 503 naming Redis. `/healthz` still 200.
5. Look at the logs. One JSON line per request, no ticket text, no keys.
6. `docker image inspect` shows the process runs as a non-root user, and `docker history` shows no secrets.

## Not in this phase

Retries, fallback, circuit breaker (next phase). Traces, metrics, deploy.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
