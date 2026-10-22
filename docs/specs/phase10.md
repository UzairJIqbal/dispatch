# Phase 10 — Load and cost

## Goal

The README can say how much load Dispatch handles before it slows down, where the provider starts saying no, what 1,000 successful requests cost, what a month would cost at 10,000 tickets a day, and how one change cut that cost without losing accuracy.

## Where this starts

Dispatch is deployed, observed and gated, but nobody knows its limits or its real cost per request.

## Build

- **k6 scripts** in `load/`, sending real-looking tickets from the dev split.
- **Test 1, the service itself, on the mock** locally in docker compose, with the mock's latency sampled from the Phase 2 baseline's real latencies. Ramp from 1 to 50 RPS in steps and hold each step. This measures our code, not the provider. No real calls.
- **Test 2, a short real ramp on staging**, with a call budget printed first and a hard stop at 300 calls: ramp until 429s appear, and watch the gateway retry and fall back on the dashboard. Trace sampling set to 10%.
- **`results/load/`**: k6's summary for each run, and a table per step: RPS, p50/p95/p99, error rate by class, fallback rate.
- **The cost model**, `pnpm cost`: from the latest eval results and the dated price table, prints average input and output tokens, cost per request, **cost per 1,000 successful requests** (failed requests still cost tokens), and a monthly projection at 10,000 tickets a day, for the primary and for the fallback model.
- **Find what dominates cost.** It's usually input tokens: the system prompt sent every time.
- **One cost experiment**: a trimmed prompt as a new version (fewer words, fewer examples). Run it through the eval on dev, then the CI gate and a canary like any other change. Record input tokens before and after, and accuracy before and after with the noise floor.

## Constraints

- **Real-provider load only on staging, only within the printed budget.** Never on production. Never with Groq or Cloudflare.
- **Every number in the load table says which test, how many requests, and whether it was mock or real.**
- Cost numbers are list-price estimates with the table's date. The README says the actual bill was $0.
- The trimmed prompt ships only if the gate passes. If it doesn't, write that down; a failed experiment is still a result.

## Acceptance check

1. Run test 1. `results/load/` has a table with each step, and you can say at which RPS p95 crossed the SLO.
2. Run test 2 on staging. It stops at or before 300 calls. The dashboard shows 429s, retries and fallbacks during the ramp.
3. `pnpm cost` prints cost per 1,000 successes and the monthly projection for both models.
4. The trimmed-prompt version has a gate result linked, and a before/after table: input tokens, cost per 1,000, accuracy with the noise floor.

## Not in this phase

Self-hosting break-even, semantic caching. Stretch goals after shipping.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
