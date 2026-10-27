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

The answer is the triage JSON plus `meta: { prompt_version, model, provider, fallback, git_sha, request_id, latency_ms }`; `fallback: true` means the primary failed and the fallback provider answered. Errors are `{ "error": { "class", "message" } }`. About the client's request: `bad_request` 400, `unauthorized` 401, `too_large` 413 (over 4,000 characters), `rate_limit` 429 with `Retry-After`. From the gateway (never the client's fault): `rate_limit`, `provider_5xx`, `connection`, `auth` and `circuit_open` 503, `timeout` 504, `schema_fail` and `bad_request` 502. `GET /healthz` says the process is up; `GET /readyz` checks config, Redis, provider keys and the circuits, and names the one that fails.

Both `pnpm dev` and docker compose use the mock unless `DISPATCH_PROVIDER=gemini` is set. Which prompt version is live comes from `config/release.yaml`. Every variable is in `.env.example`.

| Service | Free limit that matters (checked 2026-10-28) | What it means here |
|---|---|---|
| Upstash Redis | 500,000 commands/month, 256 MB, no card | the 60/min sliding window costs ~4 commands per request, so ~120,000 requests a month |

If Redis can't be reached, the rate limit lets requests through (logged as `ratelimit.unavailable`) and `/readyz` turns 503: a Redis outage shouldn't take triage down with it.

## The gateway

Every model call goes through one gateway, configured in `config/models.yaml`. Each attempt is cut off after 10 s and the whole request after 20 s. `rate_limit`, `timeout`, `provider_5xx` and `connection` are retried up to 2 times with full-jitter backoff (a random wait between 0 and min(4 s, 500 ms × 2^retry)), or for exactly the `Retry-After` the provider sends. `bad_request` and `auth` are never retried. Then the `fallback` alias answers (Gemini → Cohere). A provider with 5 failures in 30 s gets its circuit opened: it is skipped for 30 s, then one trial request decides. An answer that fails the schema gets one repair call; still broken is `schema_fail`. Each attempt logs one `gateway.attempt` line with `provider`, `attempt`, `error_class`, `wait_ms` and `decision`.

Drills run on the mock, zero real calls. `MOCK_MODE` breaks the primary mock; `mock_fallback` answers unless `MOCK_FALLBACK_MODE` is set:

```sh
MOCK_MODE=500 pnpm dev                          # 3 primary attempts, then the fallback; 5 failures open the circuit
MOCK_MODE=429 MOCK_RETRY_AFTER=2 pnpm dev       # the log shows wait_ms 2000
MOCK_MODE=bad_json_once pnpm dev                # one repair, then a valid answer (bad_json: 502 schema_fail)
MOCK_MODE=hang pnpm dev                         # 504 timeout within 20 s
```

Modes: `ok`, `429`, `500`, `hang`, `bad_json`, `bad_json_once`, `slow` (real latencies from the baseline), `400`, `401`, `connection`.
