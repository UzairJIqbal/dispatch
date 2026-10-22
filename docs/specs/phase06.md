# Phase 6 — Metrics, the dashboard, SLOs and alerts

## Goal

`docker compose up` brings up Dispatch with Prometheus and Grafana, and the dashboard shows live requests per second, p50/p95/p99 against the SLO line, errors by class, fallbacks, circuit states, cost per minute and the error budget left. Two alerts are defined and can be made to fire.

## Where this starts

The traced service with the full gateway. Each request can be inspected, but there's no view of the whole service over time.

## Build

- **`/metrics`** with `prom-client`: the metric list from the project specs (requests by route/status/error class, request latency histogram by prompt version/provider/release, attempt latency by provider, tokens in/out, estimated cost, fallbacks, repairs, schema failures, circuit state), plus Node's default process metrics. Basic auth when a password is set.
- **Histogram buckets** chosen for LLM latency (for example 0.1 s to 20 s), written in one place.
- **docker compose** adds Prometheus (scraping the service every 15 s) and Grafana with the data source and the dashboard provisioned from files, so a fresh `docker compose up` has the dashboard with no clicking.
- **The dashboard**, built in Grafana and saved as JSON in `ops/grafana/`: RPS; p50/p95/p99 with the SLO line; errors by class, stacked; fallback rate; circuit state per provider; tokens in/out; cost per minute; availability over 7 days and error budget remaining.
- **`docs/SLOS.md`**: the three SLOs from the project specs, with the number for each set from your Phase 2 baseline and one line on why.
- **Two alert rules** as files in `ops/`: fast error-budget burn (1 h window at 14.4×, confirmed over 5 min) and cost spike (cost per minute above 3× the 24 h average for 10 min).
- **`pnpm traffic`**: sends dev tickets to a running service at a set rate (default 1 RPS) with a realistic mix, so the dashboard has something to show. Defaults to the mock.

## Constraints

- **No high-cardinality labels.** Never a ticket id, request id, client key or text in a label. A test lists every label in use.
- **Error classes are the same names** as in the gateway and the logs.
- **The SLO line and the burn-rate maths match `docs/SLOS.md`.** No number only in the dashboard.
- Prometheus and Grafana run only in docker compose. The service doesn't need them to start.
- Grafana's admin password comes from the env file.

## Acceptance check

1. `docker compose up` on a fresh clone. Grafana opens with the dashboard already there.
2. Run `pnpm traffic` on the mock for 5 minutes. Every panel has data.
3. Set the mock primary to `500` while traffic runs. Within a minute the error panel shows `provider_5xx`, the fallback rate rises, the circuit panel shows the primary open, and availability stays up because the fallback answers.
4. Set both providers to fail. Availability drops, and the fast-burn alert goes to pending then firing in Grafana.
5. Set the mock to `slow` with long latency. p95 crosses the SLO line on the latency panel.
6. Take a screenshot of the dashboard under load. It goes in the README later.

## Not in this phase

Grafana Cloud and deploy (next phase). Canary panels.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
