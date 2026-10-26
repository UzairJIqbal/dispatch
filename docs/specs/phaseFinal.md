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
- **The positioning line** right under the opening sentence: *the model call is one line; everything around it is the project.* The README never sells the classifier.
- **The injection slice's "held" rate** with n, next to the headline accuracy.
- **A "Why not LiteLLM / Portkey" section**: which gateway features Dispatch rebuilds (retries by error class, fallback, circuit breaker, repair, typed errors, a mock that fails on command) and which it leaves out on purpose (budgets per key, virtual keys, SSO, semantic cache); that swapping is a one-file change behind the one gateway function; and that a gateway holds every provider key (LiteLLM's PyPI package was compromised in March 2026; check the source before quoting).
- **A "Limitations" section**: the traffic is synthetic; the test split is ~70 tickets, so one ticket is about 1.4 points; free tiers only; the GenAI conventions are still Development.
- **A "Data handling" section** (from Phase 5).
- **A "What I'd change at scale" section**: more instances (where auto-rollback runs), a queue, self-hosting break-even, a semantic cache with a false-hit rate.
- A curl example against production with a demo key that is rate-limited hard.
- A licence, and the repo's description, website and topics on GitHub.

### Outside the repo

- **Resume bullets**, 3 to 4, each in the form "did X, measured by Y, by doing Z", each number with its baseline and test conditions (synthetic, mock or real, n), each pointing at one piece of evidence (the blocked PR, the drill video, the load table, the postmortem). Use `proficiently:tailor-resume` per job.
- **A one-line and a 30-second pitch**, written down, using the same numbers as the README.
- **One write-up** of the canary drill or the failover game day (blog or LinkedIn), linking the repo.
- **The GitHub profile**: Dispatch pinned, with the profile README pointing at it (`github-profile-optimization`).
- **An interview-story list**: the drill (passed CI, failed canary), the noise floor and why the gate threshold respects it, why not LiteLLM, the cost cut, one real bug from the postmortem. One paragraph each.

## Constraints

- **Nothing about how Dispatch works changes in this phase.**
- **The resume and the write-up use only numbers that are in the README**, with the same baseline and n. No rounding up, no dropping "synthetic".
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
7. The README has the positioning line, "Why not LiteLLM / Portkey", "Limitations" and "Data handling" sections.
8. Every resume bullet's number matches the README, with its baseline and n, and links to its evidence.

## Not in this phase

New features. Stretch goals (semantic cache, shadow deploys, drift monitoring, Kubernetes, vLLM) after shipping.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
