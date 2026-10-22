# Phase 2 — The triage call and the baseline

## Goal

One command runs every dev ticket through the AI and prints a report card: accuracy per field, schema-valid rate, p50/p95/p99 latency, tokens and estimated cost. The test-split result is saved as the baseline every later change is compared against.

## Where this starts

The golden set from Phase 1, versioned and split. No model call exists. Add a Cerebras key and a Mistral key to `.env` (from cloud.cerebras.ai and console.mistral.ai). Not Groq, not Cloudflare.

## Build

- **The output schema** in Zod: category (from the one list), priority (`low | medium | high`), summary (1 to 120 characters).
- **The first prompt file**, `prompts/triage/v1.yaml`: system prompt, model alias, temperature 0, `max_tokens`, and the instruction to answer only with the JSON. A loader validates it.
- **The model config**: aliases `fast` → Cerebras and a model name, `fallback` → Mistral and a model name, each with its base URL and key variable. Check both providers' current docs for model names that support JSON output.
- **A provider interface** with three implementations: Cerebras and Mistral through the `openai` package with their base URLs, and the **mock**, which answers deterministically from the ticket text and can be told to be slow. No retries, no fallback yet: one plain call.
- **`triage(text, version)`**: loads the prompt file, makes the call, parses and validates the JSON. Returns the answer plus tokens in/out, latency, provider, model and prompt version. A broken answer is returned as a `schema_fail` result, not thrown.
- **The response cache** in SQLite, keyed by provider, model, prompt version, parameters and ticket text. `--no-cache` skips it.
- **The graders**, as pure functions: category, priority, both correct, dangerous miss, the summary checks from the project specs.
- **A dated price table** in the config: list price per million input and output tokens for each model, with the date you copied it.
- **`pnpm eval --split dev|test [--version] [--provider] [--no-cache]`**: runs the tickets a few at a time, prints the report card and writes `results/<timestamp>-<version>-<split>.json` with every ticket's answer and grade. `--write-baseline` writes `results/baseline.json`.
- **`pnpm eval:noise`**: runs the test split twice uncached at temperature 0 and prints how many tickets flipped between the two runs. Written into the baseline as the noise floor.

## Constraints

- **Latency stats come only from uncached calls.** The report says how many calls were cached and leaves them out of p50/p95/p99.
- **Never tune the prompt on test.** Look at dev mistakes only. The test split is graded, never read.
- **No prompt text in code.** The prompt lives in its file.
- **No model name in code.** It lives in the config.
- Cost is labelled as a list-price estimate with the table's date; the free tiers cost $0.
- A missing key fails at startup with the variable name and where to get it.
- A rate-limit error stops the run with a plain line, and a rerun picks up from the cache.
- The eval prints its call count before it starts.

## Acceptance check

1. `pnpm eval --split dev --provider mock` runs with no keys and no network, and prints a full report card.
2. `pnpm eval --split dev` runs on Cerebras. The report card has every number from the project specs, with n.
3. Run it again. It finishes in a few seconds, every call cached, and latency says "no uncached calls".
4. `pnpm eval --split dev --provider mistral` runs on the fallback model, so you know how good the fallback is.
5. Look at five dev mistakes, make `v2` of the prompt, and rerun dev. The report shows `v2` and the cache missed for every ticket.
6. `pnpm eval:noise` prints the flip count. Then `pnpm eval --split test --no-cache --write-baseline` saves `results/baseline.json` with the version, dataset version, noise floor and every number.

## Not in this phase

Retries, fallback, the service, traces, metrics.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
