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

The answer is the triage JSON plus `meta: { prompt_version, model, provider, git_sha, request_id, latency_ms }`. Errors are `{ "error": { "class", "message" } }`: `bad_request` 400, `unauthorized` 401, `too_large` 413 (over 4,000 characters), `rate_limit` 429 with `Retry-After`, `schema_fail` 502, `provider_error` 503. `GET /healthz` says the process is up; `GET /readyz` checks config, Redis and provider keys, and names the one that fails.

Both `pnpm dev` and docker compose use the mock unless `DISPATCH_PROVIDER=gemini` is set. Which prompt version is live comes from `config/release.yaml`. Every variable is in `.env.example`.

| Service | Free limit that matters (checked 2026-10-28) | What it means here |
|---|---|---|
| Upstash Redis | 500,000 commands/month, 256 MB, no card | the 60/min sliding window costs ~4 commands per request, so ~120,000 requests a month |

If Redis can't be reached, the rate limit lets requests through (logged as `ratelimit.unavailable`) and `/readyz` turns 503: a Redis outage shouldn't take triage down with it.
