# Phase 4 — The gateway

## Goal

You break the primary provider on purpose, and requests still succeed through the fallback, with every retry, wait and fallback decision visible in the logs. A broken JSON answer is repaired once or returned as a typed error, never passed on.

## Where this starts

A working service and eval that make one plain call per ticket, with no retries and no fallback. A provider that's down or slow makes requests fail or hang.

## Build

- **One gateway function** that every model call goes through. The provider interface from Phase 2 sits behind it.
- **Error classes**: every failure is classified as `rate_limit`, `timeout`, `provider_5xx`, `connection`, `bad_request`, `auth`, `schema_fail` or `circuit_open`. Logs, responses and (later) metrics use these names.
- **Timeouts**: a per-attempt timeout (10 s) and a whole-request deadline (20 s), both in the config. A hung call is cancelled.
- **Retries on retryable classes only**: `rate_limit`, `timeout`, `provider_5xx`, `connection`. At most 2 retries per provider. Never on `bad_request` or `auth`.
- **Exponential backoff with full jitter**: a random wait between 0 and `min(cap, base × 2^attempt)`, base 500 ms, cap 4 s. If the provider sent `Retry-After`, wait that long instead, unless it would pass the deadline, then fall back now.
- **Fallback** to the `fallback` alias after the primary's retries are used up or its circuit is open. The answer is marked `fallback: true` in `meta`.
- **Circuit breaker per provider**: closed → open after 5 failures within 30 s → after 30 s, half-open lets one trial request through → success closes, failure opens again. All numbers in the config. An open circuit is skipped instantly, without waiting for a timeout. When every provider's circuit is open, the request fails fast with `circuit_open` (503).
- **Repair retry**: an answer that fails Zod goes back to the same provider once, with the Zod error message. Still broken → `schema_fail` (502).
- **The mock gets failure modes**: `ok`, `429` (with or without `Retry-After`), `500`, `hang`, `bad_json`, `bad_json_once`, `slow`. Set per call in tests, or by environment for whole-service drills.
- **`/readyz`** now also fails when every real provider's circuit is open.
- **One log line per attempt**: provider, attempt number, error class, wait before the next try, and the final decision (success, retry, fallback, give up).

## Constraints

- **Every reliability behaviour is tested on the mock with Vitest**, with zero real calls: each error class, each retry decision, `Retry-After`, the deadline, every circuit state change, repair once then fail.
- **Use fake timers in tests** so a 30-second circuit wait doesn't make the tests slow.
- **Never retry a non-retryable error.** A test proves a 400 is called exactly once.
- **Never return an answer that failed validation.**
- The eval goes through the gateway too, so its numbers include retries; the report counts retries and fallbacks.
- This phase goes through a pull request with CodeRabbit before merging.

## Acceptance check

1. `pnpm test`: every gateway test passes, and none of them touches the network.
2. Start the service with the mock primary set to `500`. Requests succeed through the fallback, `meta.fallback` is true, and the logs show 3 attempts on the primary then the fallback.
3. Set the mock to `500` and send 10 requests quickly. After the 5th, the logs show the circuit open and later requests skip the primary with no wait. After 30 s, one trial request goes through.
4. Set the mock to `429` with `Retry-After: 2`. The log shows a 2-second wait before the retry.
5. Set the mock to `bad_json_once`. The answer is valid and the log shows one repair. Set it to `bad_json`: the response is 502 `schema_fail`.
6. Set the mock to `hang`. The request returns within the 20 s deadline with a typed error, never hangs.
7. Put a wrong Cerebras key in `.env` and send a real ticket. It's classified `auth`, not retried, and answered by Mistral.

## Not in this phase

Traces and metrics (next two phases). Per-client fallback rules.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
