# Phase 2 — The triage call and the baseline

## Goal

One command runs every dev ticket through the AI and prints a report card: accuracy per field, schema-valid rate, p50/p95/p99 latency, tokens and estimated cost. The test-split result is saved as the baseline every later change is compared against.

## Where this starts

The golden set from Phase 1, versioned and split. No model call exists. Add a Gemini key and a Cohere trial key to `.env` (from aistudio.google.com/apikey and dashboard.cohere.com/api-keys). Both are free with no card and work from Pakistan. Not Groq, not Cloudflare.

## Build

- **The output schema** in Zod: category (from the one list), priority (`low | medium | high`), summary (1 to 120 characters).
- **The first prompt file**, `prompts/triage/v1.yaml`: system prompt, model alias, temperature 0, `max_tokens`, and the instruction to answer only with the JSON. The ticket goes in a clearly fenced block that the prompt calls data, not instructions. A loader validates it.
- **The model config**: aliases `fast` → Gemini and a model name, `fallback` → Cohere and a model name, each with its base URL and key variable. Check both providers' current docs for model names that support JSON output. Each provider also carries its free-tier requests per minute, and calls to it are spaced to stay under that limit. Extra parameters a model needs (such as a reasoning effort) live with the model, not the prompt. Pin dated model names, never a `-latest` alias, so the baseline can't move underneath you.
- **A provider interface** with three implementations: Gemini and Cohere through the `openai` package with their base URLs, and the **mock**, which answers deterministically from the ticket text and can be told to be slow. No retries, no fallback yet: one plain call.
- **`triage(text, version)`**: loads the prompt file, makes the call, parses and validates the JSON. Returns the answer plus tokens in/out, latency, provider, model and prompt version. A broken answer is returned as a `schema_fail` result, not thrown.
- **The response cache** in SQLite, keyed by provider, model, prompt version, parameters and ticket text. `--no-cache` skips it.
- **The graders**, as pure functions: category, priority, both correct, dangerous miss, the summary checks from the project specs.
- **A dated price table** in the config: list price per million input and output tokens for each model, with the date you copied it.
- **The report card breaks both-correct down by slice** (`bitext`, `messy`), each with its n, under the total. Shown, never gated.
- **`pnpm eval --split dev|test [--version] [--provider] [--no-cache]`**: runs the tickets a few at a time, prints the report card and writes `results/<timestamp>-<version>-<split>.json` with every ticket's answer and grade. `--write-baseline` writes `results/baseline.json`.
- **`pnpm eval:noise`**: runs the test split twice uncached at temperature 0 and prints how many tickets flipped between the two runs. Only tickets answered in both runs are compared; a ticket that failed in either (timeout, 5xx, broken JSON) is the provider, not the model, so it is counted separately, never as a flip. Written into the baseline as the noise floor.

## Constraints

- **Latency stats come only from uncached calls.** The report says how many calls were cached and leaves them out of p50/p95/p99.
- **Never tune the prompt on test.** Look at dev mistakes only. The test split is graded, never read.
- **No prompt text in code.** The prompt lives in its file.
- **No model name in code.** It lives in the config.
- Cost is labelled as a list-price estimate with the table's date; the free tiers cost $0.
- A missing key fails at startup with the variable name and where to get it.
- A rate-limit error stops the run with a plain line, and a rerun picks up from the cache.
- **A baseline has no failed calls.** If any call fails, the run is still saved but `results/baseline.json` is not written, with a line saying how many failed and why. Retries come in Phase 4.
- **Stay inside the free plans.** Calls are paced to each provider's free per-minute limit, so a slow run is expected, not a bug. The eval prints the expected time with the call count.- The eval prints its call count before it starts.

## Acceptance check

1. `pnpm eval --split dev --provider mock` runs with no keys and no network, and prints a full report card.
2. `pnpm eval --split dev` runs on Gemini. The report card has every number from the project specs, with n.
3. Run it again. It finishes in a few seconds, every call cached, and latency says "no uncached calls".
4. `pnpm eval --split dev --provider cohere` runs on the fallback model, so you know how good the fallback is.
5. Look at five dev mistakes, make `v2` of the prompt, and rerun dev. The report shows `v2` and the cache missed for every ticket. The five mistakes and what `v2` changed because of them are written down in a short error-analysis note in the repo (dev only, never test). It's an interview story later.
6. `pnpm eval:noise` prints the flip count. Then `pnpm eval --split test --no-cache --write-baseline` saves `results/baseline.json` with the version, dataset version, noise floor and every number.
7. The report card shows the `messy` slice separately from `bitext`, each with n.

## Not in this phase

Retries, fallback, the service, traces, metrics.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
