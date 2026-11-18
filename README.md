# Dispatch

A small AI service that reads a customer-support ticket and returns its category, priority and a one-line summary as JSON, run the way a production team runs an LLM feature. See `docs/project-specs.md`.

## Golden set

```sh
pnpm install
pnpm golden:import   # downloads Bitext (pinned), samples 242 tickets + 30 messy → evals/tickets.jsonl
pnpm label           # label priority one ticket at a time; resumes where you stopped
pnpm golden:stats    # counts per category, priority and split
```

Priority rules: `evals/LABELLING.md`. Dataset versions: `evals/CHANGELOG.md`.

## Eval

```sh
cp .env.example .env                       # add the two free keys
pnpm eval --split dev --provider mock      # no keys, no network
pnpm eval --split dev                      # Gemini; reruns are served from the cache
pnpm eval --split dev --provider cohere    # the fallback model
pnpm eval:noise                            # test split twice: how much the score moves by chance
pnpm eval --split test --no-cache --write-baseline
```

Free-tier limits (checked 2026-10-26), set in `config/models.yaml` and paced automatically:

| Provider | Limit that matters | What it means here |
|---|---|---|
| Gemini (Flash-Lite), primary | ~10 requests/min, ~500 requests/day, no card | a 198-ticket dev run takes ~22 min and uses ~40% of the day; noise + baseline (222 calls) fit in the same day |
| Cohere (Command A), fallback | 20 requests/min, 1,000 requests/month, no card; trial keys are not for production | a dev run takes ~13 min and uses ~20% of the month |

Gemini's free tier may train on prompts. The golden set is public and synthetic data, so that is acceptable here; a real deployment would use a paid tier.

Cost is shown as a list-price estimate with the price table's date; on the free tiers it is $0.

## Eval gate

A pull request that makes the AI worse can't be merged. `ci.yml` runs on every PR: types, lint, tests on the mock and a gitleaks secret scan. `eval-gate.yml` runs when a PR touches prompts, the model config, the triage, gateway, grading or golden-set code: it grades the candidate on the test split (n=74, about 74 real Gemini calls uncached) and compares it with main's latest baseline, kept as a CI artifact by every push to main that touches the AI. Branch protection needs both to pass.

The rules live in `config/gate.yaml` and each is checked on its own:

| Rule | Fails when |
|---|---|
| Both correct | drops more than 2 points, or the noise floor if larger (4.1 points: 3 of 74 tickets flipped between two identical runs) |
| Dangerous misses (high labelled low) | any new one |
| Schema-valid first try | drops more than 2 points |
| p95 latency | rises more than 15%; uncached calls only, and "not measured" (not a pass) when every call was cached |
| Cost per request (list price) | rises more than 15% |

The table, with n and a per-slice breakdown shown for information only, is one PR comment updated on each push, and the job summary. A PR from a fork has no key, so the gate says "skipped: no key" and fails. A PR that changes the golden set without bumping its version fails. The response cache is kept between runs, so an unchanged rerun spends nothing.

Proof, against main's v2 baseline (both correct 70.3%, 52/74):

- [PR #6](https://github.com/UzairJIqbal/dispatch/pull/6), a deliberately worse prompt (priority rules removed): **failed**, both correct 52.7% (39/74), −17.6 points against a 4.1-point limit. Merge blocked.
- [PR #5](https://github.com/UzairJIqbal/dispatch/pull/5), an equal prompt: passed, 73.0% (54/74), within the noise floor.
- [PR #7](https://github.com/UzairJIqbal/dispatch/pull/7), the real trimmed-prompt experiment: accuracy, cost and schema passed, p95 failed (1.64 s → 8.38 s, n=74), so it didn't ship (see [Load and cost](#load-and-cost)).

## The service

```sh
pnpm client-key acme       # prints a key (give it to the client) and the line for DISPATCH_CLIENT_KEYS
pnpm dev                   # local, on the mock provider, port 3000
GIT_SHA=$(git rev-parse --short HEAD) docker compose up --build   # the same, in Docker (DISPATCH_HOST_PORT=3100 if 3000 is taken)

curl -s localhost:3000/v1/triage \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text": "I was charged twice for my order"}'
```

The answer is the triage JSON plus `meta: { prompt_version, release, model, provider, fallback, git_sha, request_id, trace_id, latency_ms }`; `fallback: true` means the primary failed and the fallback provider answered. Errors are `{ "error": { "class", "message" } }`. About the client's request: `bad_request` 400, `unauthorized` 401, `too_large` 413 (over 4,000 characters), `rate_limit` 429 with `Retry-After`. From the gateway (never the client's fault): `rate_limit`, `provider_5xx`, `connection`, `auth` and `circuit_open` 503, `timeout` 504, `schema_fail` and `bad_request` 502. `GET /healthz` says the process is up; `GET /readyz` checks config, Redis, provider keys and the circuits, and names the one that fails.

Both `pnpm dev` and docker compose use the mock unless `DISPATCH_PROVIDER=gemini` is set. Which prompt version is live comes from the release config in Redis (`config/release.yaml` until one is written; see [Canary release](#canary-release)). Every variable is in `.env.example`.

| Service | Free limit that matters (checked 2026-10-28) | What it means here |
|---|---|---|
| Upstash Redis | 500,000 commands/month, 256 MB, no card | the 60/min sliding window costs ~4 commands per request, so ~120,000 requests a month |

If Redis can't be reached, the rate limit lets requests through (logged as `ratelimit.unavailable`) and `/readyz` turns 503: a Redis outage shouldn't take triage down with it.

## The gateway

Every model call goes through one gateway, configured in `config/models.yaml`. Each attempt is cut off after 10 s and the whole request after 20 s. `rate_limit`, `timeout`, `provider_5xx` and `connection` are retried up to 2 times with full-jitter backoff (a random wait between 0 and min(4 s, 500 ms × 2^retry)), or for exactly the `Retry-After` the provider sends. `auth` and `bad_request` are never retried: they go straight to the fallback, which gets its one try (a retired model or a parameter one provider refuses is what it's for). Then the `fallback` alias answers (Gemini → Cohere); the primary stops 10 s before the deadline so a hung primary still leaves the fallback a full attempt (unless the fallback's circuit is open, then the primary gets all 20 s). A provider with 5 failed attempts in 30 s gets its circuit opened: it is skipped for 30 s, then one trial request decides; an attempt cut short by our own deadline, or a cache hit, doesn't count either way. An answer that fails the schema gets one repair call per provider (a failed repair call is retried as a repair); still broken is `schema_fail`. Each attempt logs one `gateway.attempt` line with `provider`, `attempt`, `error_class`, `wait_ms` and `decision`.

Drills run on the mock, zero real calls. `MOCK_MODE` breaks the primary mock; `mock_fallback` answers unless `MOCK_FALLBACK_MODE` is set:

```sh
MOCK_MODE=500 pnpm dev                          # 3 primary attempts, then the fallback; 5 failures open the circuit
MOCK_MODE=429 MOCK_RETRY_AFTER=2 pnpm dev       # the log shows wait_ms 2000
MOCK_MODE=bad_json_once pnpm dev                # one repair, then a valid answer (bad_json: 502 schema_fail)
MOCK_MODE=hang pnpm dev                         # primary cut off at 10 s, the fallback answers
MOCK_MODE=hang MOCK_FALLBACK_MODE=hang pnpm dev # 504 timeout within 20 s
```

Modes: `ok`, `429`, `500`, `hang`, `bad_json`, `bad_json_once`, `slow` (real latencies from the baseline), `400`, `401`, `400_key` (Gemini's wrong-key answer), `connection`.

## Tracing

Every `/v1` request is one trace in Langfuse (sent over OpenTelemetry): a root span `triage.request`, and under it a `ratelimit.check` span (the Redis round trip) and one `gen_ai.chat` span per model attempt with the provider, model, tokens, finish reason, attempt number, fallback, repair, cache hit and error class. The gateway's decisions are span events (`gateway.retry_wait`, `gateway.circuit_open`, `gateway.fallback`, `gateway.repair`); Langfuse doesn't draw span events, so each is also a short child span. Every log line inside a request and the answer's `meta.trace_id` carry the trace id, so a log line leads to its trace. `pnpm eval` traces each ticket, and a run is one Langfuse session named after the run id, with each ticket's `trace_id` in the results file.

`TRACE_SAMPLE_RATE` sets the share of requests traced (1 normally, 0.1 for load tests); a request's spans are kept or dropped together. If Langfuse is down or a key is wrong, the service logs one `tracing.export` warning and goes on serving. On shutdown, pending spans are flushed (up to 3 s).

Attribute names follow the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) at commit `51a0f58` (2026-10-27). They are still marked **Development** and change often, so the version is pinned here and in `src/tracing/tracing.ts`. One deviation: the attempt span is named `gen_ai.chat`, not the convention's `chat {model}`, so every attempt has the same name to search by; the model is in `gen_ai.request.model`.

### Data handling

What leaves the process for Langfuse: labels (category, priority), token counts, timings, error classes, provider and model names, prompt version, git SHA, the client's name and request and trace ids. What never leaves: ticket text, summaries and API keys. So a trace has no input in Langfuse, and its output is just the labels. The one exception is `TRACE_CAPTURE_CONTENT=true`, for local debugging: it adds the ticket and the answer to spans with emails and phone numbers replaced by `[email]` and `[phone]`. It is off by default, forced off in docker compose, and ignored whenever `NODE_ENV=production` (the image sets it).

## Metrics and SLOs

`GET /metrics` is in Prometheus format: requests by route, status and error class; triage latency by prompt version, provider and release; per-attempt latency; tokens; list-price cost; fallbacks; repairs; schema failures; circuit state (0 closed, 1 half-open, 2 open); and Node's defaults. Labels only take values from small fixed sets, never a ticket, client or id (`test/metrics.test.ts` lists every one). With `METRICS_PASSWORD` set it needs basic auth, user `metrics`.

`docker compose up` also starts Prometheus (`:9090`, scraping every 15 s) and Grafana (`:3001`, user `admin`, `GRAFANA_ADMIN_PASSWORD` from `.env`), with the data source, the dashboard (`ops/grafana/dispatch.json`) and two alerts provisioned from files. The three SLOs, their baselines and the alerts are in [docs/SLOS.md](docs/SLOS.md); `test/slos.test.ts` checks the dashboard and alerts use the same numbers.

`pnpm traffic [--rate 1] [--duration 300]` sends dev tickets to the service at a steady rate so every panel has data. It refuses to run against a real provider unless given `--real`. The drill commands are at the top of `compose.yaml`.

## Deploy

Staging and production are two Azure Container Apps (`dispatch-staging`, `dispatch-prod`) in one Consumption environment in Malaysia West, the allowed region closest to the Upstash database in Mumbai. Each app has its own client keys, `/metrics` password and Redis key prefix, set as secrets on the app. Health probes: `/healthz` for startup and liveness, `/readyz` for readiness.

One image is built once per push to main and runs everywhere. Staging gets it automatically. Production gets the same image, by digest, only when promoted by hand. Workflows log in to Azure with OIDC (a short-lived token per run, no stored password) and read client keys from GitHub secrets: nothing secret is in a workflow file or in the image.

| Workflow | When | What |
|---|---|---|
| `deploy` | every push to main | Builds and pushes `ghcr.io/<owner>/dispatch:<git sha>`, deploys that digest to `dispatch-staging` (`az containerapp update`), waits for `/readyz` on that commit, then sends 3 real dev tickets (`pnpm smoke`). |
| `promote` | by hand: Actions → promote → Run workflow | Takes a tag (empty = whatever staging serves), finds its digest, deploys exactly that to `dispatch-prod`, waits for `/readyz` on that commit. No rebuild. |
| `probe` | every 10 / 30 min | `/readyz` on production every 10 minutes, one real ticket with the `probe` client key every 30. A failed probe fails the run, and GitHub emails it. |

`pnpm smoke --url <service> [--sha <commit>] [--count 3]` runs the same check by hand (client key in `SMOKE_KEY`). It logs ticket ids and labels, never ticket text, because Actions logs on a public repo are public.

`pnpm grafana:push` puts the committed dashboard and both alert rules into Grafana Cloud (`GRAFANA_URL`, `GRAFANA_TOKEN`, `ALERT_EMAIL` in `.env`). It only swaps the local data source for the stack's own and adds an email contact point; `test/grafana.test.ts` checks that nothing else changes. Grafana Cloud scrapes production `/metrics` once a minute with basic auth (user `metrics`) through its Metrics Endpoint integration, scrape job `dispatch`.

Production traffic is synthetic: the probe, the smoke tests and requests sent by hand. The dashboard shows how the service behaves, not real customer load.

### Free limits and cost (checked 2026-11-13)

| Service | Free limit | What it means here |
|---|---|---|
| Azure for Students | $100 credit a year, no card; services stop when it runs out, nothing is charged. Container Apps list prices in Malaysia West: $0.000028 per vCPU-second active, $0.000004 idle, $0.000004 per GiB-second; the first 180,000 vCPU-s and 360,000 GiB-s a month are free. | Production is one always-on replica at 0.25 vCPU / 0.5 GiB: about $6 a month if billed as idle, up to about $17 if every second counts as active (the scrape every minute may keep it active). That is 6 to 16 months of credit. Staging scales to zero and costs about nothing. No Log Analytics workspace, so logs cost nothing either; the real figure goes here after a few days of Cost Management data. |
| Grafana Cloud | 10k active metric series, 14 days retention, 3 active users. The Metrics Endpoint integration scrapes HTTPS URLs only, with auth required, every minute by default. | Our labels are bounded (`test/metrics.test.ts`), far under 10k. The scrape every minute also keeps production awake. |
| Grafana Synthetic Monitoring | 100k API test executions and 10k browser executions a month (grafana.com/pricing, checked 2026-11-14). | One HTTP check on prod `/readyz` from 3 locations every 2 minutes is about 65k runs a month (n=3 probes x 21,600; baseline: 100k free). Its failed-check alert emails `dispatch-email`. Definitions are in `ops/synthetics/`. |
| GitHub Actions | Free on a public repo. Schedules run at most every 5 minutes, can start late when GitHub is busy (worst at the top of the hour), and are switched off after 60 days with no repo activity. A failed scheduled run emails whoever last edited its cron line. | A late or skipped probe shows as a gap, not an error. Measured: on 2026-10-31 the schedule started only 5 runs in about 11 hours (n=5, baseline: 6 an hour asked for), and on 2026-11-13 none in 90 minutes after it was re-enabled. Steady uptime probing therefore uses Grafana Synthetic Monitoring instead (below). |
| GitHub Container Registry | Free for public images | The `dispatch` package is public, so Container Apps pulls it with no credentials. |
| Gemini (free tier) | A daily request quota per model, shared by everything using the key | The probe spends about 48 calls a day and each staging deploy 3, from the same quota as `pnpm eval`. |

Sources: [Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/), [Container Apps billing](https://learn.microsoft.com/azure/container-apps/billing), [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices), [Grafana Cloud pricing](https://grafana.com/pricing/), [Metrics Endpoint integration](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-metrics-endpoint/), [GitHub schedule event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

## Canary release

A canary is a new prompt version that gets a small share of real traffic while the stable one keeps the rest, so a bad change hurts a few requests instead of all of them. Which version is stable, the canary and its share, and the rollback criteria live in Upstash Redis under `<REDIS_KEY_PREFIX>:release`, validated with Zod. The service re-reads it every 30 s, so a release never needs a rebuild or a redeploy. Every answer, log line, trace and metric says `release: stable | canary`.

```bash
pnpm release status                       # what is written, what the service serves, which prompts its image has
pnpm release set-criteria                 # first: after 50 canary requests, roll back if p95 > 1.25x stable,
                                          #   errors > stable + 2 points, or schema-valid < 95% (last 10 min)
pnpm release canary v1 10 --target staging  # 10% to v1; refused if v1 isn't in the deployed image
pnpm release promote                      # the canary becomes stable
pnpm release rollback                     # every request back to stable within 30 s
```

Each command prints the config before and after. One canary at a time; criteria can't change while one runs. `--target` is `local` (default), `staging` (`STAGING_URL`) or `prod` (`PROD_URL`); the command asks that service which Redis key it reads, so staging's release can't land in production's key.

**Auto-rollback.** Every minute the service compares the canary with stable over the last 10 minutes of its own requests (p95 is the latency 95% of requests are under). If a criterion breaks it sets the canary to none, logs `release.rollback` with the numbers, and counts `dispatch_release_rollbacks_total`. It runs inside the one instance we run. With more instances each would only see its share and they could race: the check would then run once, behind a Redis lock with a short expiry, judging on the summed Prometheus series instead of one process's memory.

Drill on the mock, zero real calls: `MOCK_CANARY_MODE=slow` slows only canary requests (any `MOCK_MODE` value works). Locally (2026-11-18) it rolled the canary back after its 50th canary request: canary p95 8.13 s against stable 0.004 s (n=50 canary, 61 stable).

```bash
REDIS_KEY_PREFIX=dispatch-local MOCK_CANARY_MODE=slow RATE_LIMIT=off pnpm dev
pnpm release set-criteria && pnpm release canary v1 50
pnpm traffic --rate 1.5 --duration 150    # release.rollback in the log after ~50 canary requests
```

Staging drill, 2026-11-18 ([findings](docs/canary-drill.md)): v1 at 10% got 8.2% of answers (n=61), and `rollback` reached the service within 30 s. On the free tier a 10% canary never reaches 50 requests in 10 minutes, so the auto-rollback waits rather than judging on noise.

The Grafana dashboard has a "Canary vs stable" row: requests, p95, error rate and schema-valid rate by release, with markers for release changes and auto-rollbacks.

## Load and cost

Terms: **RPS** is requests per second. **p50/p95/p99** are the latency that 50%, 95% and 99% of requests beat. An **open model** sends requests on the clock whether or not the last one has answered, like real users, so a slow service shows as latency, not as fewer requests.

**Test 1, the service on the mock (no real calls).** The mock's latency is sampled from `results/baseline.json` (real Gemini, n=74 uncached calls), so what changes with load is our own code. k6 ramps 1, 2, 5, 10, 20, 30, 40, 50 RPS, 60 s each. The rate limit is off for this run (`RATE_LIMIT=off`, accepted only with a mock provider, the service refuses to start otherwise), so **test 1 excludes the Redis round trip** the limiter costs.

```sh
RATE_LIMIT=off MOCK_MODE=slow docker compose up -d --build dispatch
docker compose --profile load run --rm --no-deps k6        # about 9 minutes
docker compose up -d dispatch                    # back to normal
```

**Test 2, staging with real providers.** Short ramp (0.2 to 3 RPS, about 200 requests planned) that prints its call budget first, stops at 285 sent (budget 300) and stops after 10 responses with status 429. It refuses a URL containing `prod`. Set `STAGING_URL` and `STAGING_KEY` in `.env` and `TRACE_SAMPLE_RATE=0.1` on the staging app.

```sh
docker compose --profile load run --rm --no-deps k6 run /work/load/ramp-real.js
```

Both write a markdown table and the full k6 summary to `results/load/`. Every table says which test, how many requests, and mock or real. The gateway paces Gemini to the free 10 a minute, so on staging extra load mostly queues; expect our per-client 429s and queue latency before provider 429s.

Test 1 result, 2026-11-17 ([table](results/load/2026-11-17T04-01-13Z-mock-ramp.md); mock, 9,613 requests, 0 dropped): p95 is over the 4 s SLO from 1 RPS, because the mock replays the real baseline (n=74, p95 9.6 s), which is already over it. Our own code added nothing measurable up to 50 RPS: p50 stayed between 1.37 and 1.53 s at every step against the floor's 1.52 s, with no errors. Fallback ran 1.6 to 5.1% at every step, because the baseline's slowest calls hit the 10 s attempt timeout. So the SLO is set by the provider's slow tail, not by load. 

Test 2 result, 2026-11-17 ([table](results/load/2026-11-17T21-08-45Z-staging-real-ramp.md); staging, real Gemini, 95 sent of a 300 budget, 59 answered, 10% traces): the real path's ceiling is Gemini's free tier, which the gateway paces to 10 requests a minute (about 0.17 RPS). At 0.2 RPS (n=5) p50 was 6.0 s and p95 8.7 s with no errors. At 0.5 RPS (n=15) the queue in front of Gemini grew faster than it drained and 10 of 15 waited past k6's 30 s and got no answer; at 1 RPS (n=28) all of them did. At 2 RPS (n=11) our own per-client limit (60 a minute) answered 429 and the test stopped itself, before the 3 RPS step. Compared with test 1, where our code held 50 RPS on the mock: the limit is the free provider quota, not the service. A paid tier or a second key raises it; a client sending more than about 10 tickets a minute today waits.

**Cost.** `pnpm cost [--file results/<run>.json]` prices a run's tokens at list price (price table dated 2026-10-27; the real bill is $0 on the free tiers). Failed requests still cost their tokens, so cost per 1,000 successes is total spend divided by successes. Baseline run, v2 on dev (n=198), 10,000 tickets a day for 30 days:

| Model | Input / output tokens (avg) | Per 1,000 successes | Per month |
|---|---:|---:|---:|
| Gemini flash-lite (primary) | 663 / 35 | $0.29 | $86.46 |
| Cohere command-a (fallback), primary's tokens assumed | 663 / 35 | $2.02 | $606.94 |

What dominates: input tokens (70% of the primary's cost), and about 98% of those are the system prompt sent unchanged with every ticket. The trimmed-prompt experiment (v3) and its before/after table are in [docs/cost-experiment.md](docs/cost-experiment.md); v3 cut input tokens 14% and list cost 10% on dev with accuracy inside the noise floor, but the eval gate on [PR #7](https://github.com/UzairJIqbal/dispatch/pull/7) failed it on p95 latency twice (1.64 s → 8.38 s, then 7.75 s uncached, n=74 each), so it doesn't ship. A version that fails the gate never reaches a canary, so v3 had none; the PR is closed unmerged and kept as the record.
