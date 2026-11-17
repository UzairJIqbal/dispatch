# Cost experiment: trimmed prompt (v3)

**Question.** The system prompt is about 98% of the input tokens and input tokens are
about 70% of the primary's cost (`pnpm cost`, baseline, price table 2026-10-27). Does a
shorter prompt (v3) cut that without losing accuracy?

**Change.** `prompts/triage/v3.yaml` is v2 with fewer words: same category meanings,
same priority rules, same fence around the ticket, same JSON-only answer. Same model
alias, temperature and max tokens.

| | v2 | v3 |
|---|---:|---:|
| file size (bytes) | 2993 | 2567 |
| prompt text (chars / words) | 2639 / 414 | 2163 / 333 |

## Before / after

From real runs only: v2 is the Phase 2 dev run, v3 is
`results/2026-11-17T20-10-03Z-v3-dev.json` (2026-11-17, n=198, 185 priced). List prices
from the 2026-10-27 table; the real bill was $0.

| | v2 (before) | v3 (after) | Note |
|---|---:|---:|---|
| Input tokens, avg per request | 663 (dev, n=198) | 568 (−14%) | system prompt 552 of 568 (97%) |
| Output tokens, avg per request | 35 | 34 | |
| Cost per 1,000 successful requests (list price) | $0.29 | $0.26 | Gemini |
| Monthly at 10,000 tickets/day | $86.46 | $76.58 | Gemini |
| Both correct, dev split | 70.2% (139/198) | 68.7% (136/198) | within the noise floor |
| Category correct, dev | 95.5% | 91.4% | |
| Dangerous misses, dev | 9 | 9 | |
| Schema-valid first try, dev | 99.0% | 97.5% | |
| Latency p95, dev | 1.71 s | 8.82 s | 5 timeouts, 8 Cohere fallbacks that night |
| Gate on the test split (n=74) | 70.3% (52/74) on main | 68.9% (51/74) | **failed**, [PR #7](https://github.com/UzairJIqbal/dispatch/pull/7) |

Gate on PR #7, rule by rule (`config/gate.yaml`, main's baseline artifact vs v3, n=74 each):

| Rule | main (v2) | v3 | Result |
|---|---:|---:|---|
| Both correct | 70.3% | 68.9% | pass (−1.4 pts, limit 4.1) |
| New dangerous misses | 5 | 5 | pass (0 new) |
| Schema-valid first try | 100% | 100% | pass |
| Cost per request | $0.00029 | $0.00030 | pass (+3.4%) |
| p95 latency | 1.64 s | 8.38 s | **fail** (+409.7%, limit +15%) |

**Noise floor.** Two identical v2 runs on the test split (n=74) disagreed on 3 tickets
(`results/noise.json`), so about 4 points. A v3 accuracy difference smaller than that is
not evidence either way.

## How to run it

1. Dev eval for v3, to look at mistakes (about 198 real Gemini calls, about 22 minutes):
   `pnpm eval --split dev --version v3`
2. Price it next to the baseline: `pnpm cost --file results/<that run>.json`
3. Open a pull request with `prompts/triage/v3.yaml` and, if v3 should ship, the change
   that makes it the stable version. The `eval-gate` workflow runs the test split
   (about 74 real calls) and compares it with main by the rules in `config/gate.yaml`.
4. Put the run file names and the PR link in the table above.

Test split stays untouched by tuning: if v3 is edited after seeing dev mistakes, the
change is judged on dev only, and the test split is only graded by the gate.

## Canary

Not done. The canary release is Phase 9, which isn't built, so there is no traffic split
to send v3 through. v3 can't ship through a canary until that exists.

## Outcome

**v3 does not ship.** The gate failed on one rule, p95 latency, and the gate is not loosened
to let it through. Tokens went down 14% and list cost 10% on dev, accuracy moved inside the
noise floor, and no new dangerous misses appeared.

**Reruns (2026-11-17).** The first rerun passed, but it is not counted: 72 of 74 answers came
from the response cache the failed run had saved, so its p95 (1.30 s) was measured on n=2.
With that cache deleted, a full uncached rerun failed the same rule again:

| Rule | main (v2) | v3, uncached rerun | Result |
|---|---:|---:|---|
| Both correct | 70.3% (52/74) | 70.3% (52/74) | pass |
| New dangerous misses | 5 | 4 | pass (0 new, 1 fixed) |
| Schema-valid first try | 100% | 100% | pass |
| Cost per request | $0.00029 | $0.00029 | pass (+2.9%) |
| p95 latency | 1.64 s (n=74) | 7.75 s (n=74) | **fail** (+371.7%) |

v3's p50 was 0.92 s. Its p95 is set by the 3 or 4 slowest of 74 tickets, and in this run
that was 1 retry and 2 Cohere fallbacks, each waiting out the 10 s attempt timeout. So this
experiment failed on latency as the gate measures it. The prompt is a likely but unproven
cause: the same v2 prompt measured a p95 of 9.57 s in Phase 2 (`results/baseline.json`)
and 1.64 s on main's latest gate run.

Two things about the gate itself, left for the owner to decide on (not changed here):
a rerun can reuse the cache and judge latency on a handful of calls, and a p95 over 74
tickets moves with two provider hiccups.

The gate's own cost rule saw +3.4% on the test split while dev showed −10%: cost per request
counts failed and fallback calls too, and the slow night pushed two tickets to Cohere, which
is about 7× the price.
