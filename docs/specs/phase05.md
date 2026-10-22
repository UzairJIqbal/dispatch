# Phase 5 — Tracing

## Goal

You open any one request in Langfuse and see where its time went: the whole request, each model attempt, each retry wait and the fallback, with the prompt version, provider, tokens and error class on every step.

## Where this starts

The service with the full gateway. What happened to a request is only in the log lines. Create a Langfuse Cloud project (free) and put its public key, secret key and host in `.env`.

## Build

- **OpenTelemetry's Node SDK** set up once at startup, exporting over OTLP/HTTP to Langfuse's OpenTelemetry endpoint. Follow Langfuse's current docs for the endpoint and auth header.
- **A root span per request**, `triage.request`, with the route, status, client name, prompt version, release (`stable` for now), error class and `fallback`.
- **A child span per model attempt**, `gen_ai.chat`, with the GenAI attributes (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`) and ours (`app.provider`, `app.attempt`, `app.error_class`).
- **Span events** for decisions: a retry wait (with its length), a circuit opening, a fallback, a repair retry.
- **The trace id on every log line** and in the response's `meta.trace_id`, so a log line or a client's complaint leads straight to its trace.
- **Sampling** set in the config: 100% normally, lowered to 10% for load tests by one setting.
- **The eval is traced too**, each eval run under one session name in Langfuse, so you can open the trace for a dev mistake.
- **Write down which version of the GenAI semantic conventions you followed** in the README draft.

## Constraints

- **No ticket text or summary in spans by default.** A config switch turns on input/output capture for local debugging only, and it's off in Docker.
- **No key in any span attribute.**
- **Tracing never breaks a request.** If Langfuse is down or the keys are wrong, requests still work and one warning line is logged.
- Shutdown flushes pending spans.
- Tests run with tracing to an in-memory exporter and check the span tree: one root, one child per attempt, the right attributes.

## Acceptance check

1. Send one request. Open its trace in Langfuse from `meta.trace_id`. One root span with a `gen_ai.chat` child, the model, tokens and prompt version shown.
2. With the mock primary at `500`, send one request. The trace shows three failed attempts with their error class, two retry waits with their lengths, and the fallback attempt.
3. Find a slow request and explain, from its trace alone, where the time went.
4. Copy a trace id from a log line and find the same trace in Langfuse.
5. Break the Langfuse key. Requests still succeed and a single warning is logged.
6. Run `pnpm eval --split dev --provider mock`. The run appears in Langfuse as one session.

## Not in this phase

Metrics, dashboards, alerts (next phase).

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
