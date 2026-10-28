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

## The service

```sh
pnpm client-key acme       # prints a key (give it to the client) and the line for DISPATCH_CLIENT_KEYS
pnpm dev                   # local, on the mock provider, port 3000
GIT_SHA=$(git rev-parse --short HEAD) docker compose up --build   # the same, in Docker (DISPATCH_HOST_PORT=3100 if 3000 is taken)

curl -s localhost:3000/v1/triage \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text": "I was charged twice for my order"}'
```

The answer is the triage JSON plus `meta: { prompt_version, model, provider, fallback, git_sha, request_id, trace_id, latency_ms }`; `fallback: true` means the primary failed and the fallback provider answered. Errors are `{ "error": { "class", "message" } }`. About the client's request: `bad_request` 400, `unauthorized` 401, `too_large` 413 (over 4,000 characters), `rate_limit` 429 with `Retry-After`. From the gateway (never the client's fault): `rate_limit`, `provider_5xx`, `connection`, `auth` and `circuit_open` 503, `timeout` 504, `schema_fail` and `bad_request` 502. `GET /healthz` says the process is up; `GET /readyz` checks config, Redis, provider keys and the circuits, and names the one that fails.

Both `pnpm dev` and docker compose use the mock unless `DISPATCH_PROVIDER=gemini` is set. Which prompt version is live comes from `config/release.yaml`. Every variable is in `.env.example`.

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

One image is built once per push to main and runs everywhere. Staging gets it automatically. Production gets the same image, by digest, only when promoted by hand. Every workflow reads its keys from GitHub secrets: nothing secret is in a workflow file or in the image.

| Workflow | When | What |
|---|---|---|
| `deploy` | every push to main | Builds and pushes `ghcr.io/<owner>/dispatch:<git sha>`, deploys that digest to `dispatch-staging` on Render, waits for `/readyz` on that commit, then sends 3 real dev tickets (`pnpm smoke`). |
| `promote` | by hand: Actions → promote → Run workflow | Takes a tag (empty = whatever staging serves), finds its digest, deploys exactly that to `dispatch-prod`, waits for `/readyz` on that commit. No rebuild. |
| `probe` | every 10 / 30 min | `/readyz` on production every 10 minutes, one real ticket with the `probe` client key every 30. A failed probe fails the run, and GitHub emails it. |

`pnpm smoke --url <service> [--sha <commit>] [--count 3]` runs the same check by hand (client key in `SMOKE_KEY`). It logs ticket ids and labels, never ticket text, because Actions logs on a public repo are public.

`pnpm grafana:push` puts the committed dashboard and both alert rules into Grafana Cloud (`GRAFANA_URL`, `GRAFANA_TOKEN`, `ALERT_EMAIL` in `.env`). It only swaps the local data source for the stack's own and adds an email contact point; `test/grafana.test.ts` checks that nothing else changes. Grafana Cloud scrapes production `/metrics` once a minute with basic auth (user `metrics`) through its Metrics Endpoint integration, scrape job `dispatch`.

Production traffic is synthetic: the probe, the smoke tests and requests sent by hand. The dashboard shows how the service behaves, not real customer load.

### Free limits (checked 2026-10-28)

| Service | Free limit | What it means here |
|---|---|---|
| Render | 750 instance hours per workspace per month. Sleeps after 15 min with no requests. Every free service in the workspace is suspended when the hours run out. One person can own up to 5 Hobby workspaces. | Production (about 744 h a month) fills one workspace on its own, so staging lives in a second free workspace. Staging sleeps, and its first request after a nap takes about a minute. |
| Grafana Cloud | 10k active metric series, 14 days retention, 3 active users. The Metrics Endpoint integration scrapes HTTPS URLs only, with auth required, every minute by default. | Our labels are bounded (`test/metrics.test.ts`), far under 10k. The scrape every minute also keeps production awake. |
| GitHub Actions | Free on a public repo. Schedules run at most every 5 minutes, can start late when GitHub is busy (worst at the top of the hour), and are switched off after 60 days with no repo activity. A failed scheduled run emails whoever last edited its cron line. | A late or skipped probe shows as a gap, not an error. |
| GitHub Container Registry | Free for public images | The `dispatch` package is public, so Render pulls it with no credentials. |
| Gemini (free tier) | A daily request quota per model, shared by everything using the key | The probe spends about 48 calls a day and each staging deploy 3, from the same quota as `pnpm eval`. |

Sources: [Render free instances](https://render.com/docs/free), [Render workspaces](https://render.com/docs/team-members), [Render deploy hooks](https://render.com/docs/deploy-hooks), [Grafana Cloud pricing](https://grafana.com/pricing/), [Metrics Endpoint integration](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-metrics-endpoint/), [GitHub schedule event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
