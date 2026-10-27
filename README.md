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
