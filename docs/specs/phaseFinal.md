# Phase Final — Ship it

## Goal

A reviewer opens the GitHub repository, understands in one sentence what was built, sees headline numbers each with a baseline, a dashboard under load, a PR the gate blocked and a video of a rollback, and believes every number.

## Where this starts

Every phase is built and has passed its check. This phase adds nothing to what Dispatch does. It makes sure what exists is complete on GitHub and presents itself well.

## Build

### Confirm GitHub is complete

- Main has every phase merged. No open PRs from a finished phase, no unpushed commits.
- A clean clone runs with `docker compose up` following only the README, on the mock provider with no keys.
- No secret has ever been committed: gitleaks over the full history. Anything ever committed gets rotated, not just deleted.
- `.env.example` lists every variable with a one-line comment and no real values.
- The evidence is committed: `evals/golden.jsonl` and its changelog, `results/baseline.json`, `results/load/`, `docs/SLOS.md`, `ops/grafana/`, the alert rules, `RUNBOOK.md`, `postmortems/`.

### The README

- **The opening sentence, filled in with real numbers**: "I took an LLM feature from a script to a deployed service with versioned prompts, an eval gate in CI, end-to-end tracing, latency and cost SLOs, provider failover and a tested rollback." Then the headline numbers, each with a baseline and n: accuracy on test, schema-valid rate, p95 at a stated RPS, availability over 7 days, cost per 1,000 successful requests, the cost cut from the trimmed prompt.
- **The dashboard screenshot under load**, above the fold.
- **A link to the PR the eval gate blocked.**
- **The 2-minute video** of the canary rollback drill (or failover), linked.
- Then: the architecture diagram from the project specs, how the gateway decides (retry, fallback, circuit), SLOs and alerts, the release process, the load table, the cost model, what broke (link to the postmortem), the stack and why, the free-tier limits, and the OpenTelemetry GenAI conventions version.
- **A "What I'd change at scale" section**: more instances (where auto-rollback runs), a queue, self-hosting break-even, a semantic cache with a false-hit rate.
- A curl example against production with a demo key that is rate-limited hard.
- A licence, and the repo's description, website and topics on GitHub.

## Constraints

- **Nothing about how Dispatch works changes in this phase.**
- **Every number in the README links to its evidence.** A number with no evidence comes out.
- **Free plans only**, and the README says the bill was $0 and costs are list-price estimates.
- The README says the traffic is synthetic.

## Acceptance check

1. Clone fresh into an empty folder, follow only the README, `docker compose up`. The service answers on the mock and the dashboard loads.
2. gitleaks over the full history finds nothing live.
3. Every number on the README's first screen links to a file or a run that matches it.
4. The blocked-PR link opens a PR with the gate's failing table.
5. Watch the video. It shows the canary, the broken criterion and the automatic rollback in under two minutes.
6. Send the demo curl from the README. It works, and the 61st request in a minute gets 429.

## Not in this phase

New features. Stretch goals (semantic cache, shadow deploys, drift monitoring, Kubernetes, vLLM) after shipping.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
