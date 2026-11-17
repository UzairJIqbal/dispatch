# Test 2: staging, real providers (2026-11-17T21-08-45Z)

**Real model calls.** 95 requests sent (budget 300), 59 answered, to https://dispatch-staging.ashybay-480692f5.malaysiawest.azurecontainerapps.io. One client key, dev tickets only.
The test stopped before the last step (429s appeared or the budget was reached). Trace sampling on staging should be 10% (TRACE_SAMPLE_RATE=0.1).

| Step (RPS) | n | p50 ms | p95 ms | p99 ms | errors by class | fallback rate |
|---:|---:|---:|---:|---:|:--|---:|
| 0.2 | 5 | 5989 | 8688 | 8930 | none | 0.0% |
| 0.5 | 15 | 29636 | 29716 | 29723 | no_answer 10 (66.7%) | 0.0% |
| 1 | 28 | 30001 | 30005 | 30005 | no_answer 28 (100.0%) | 0.0% |
| 2 | 11 | 471 | 1346 | 1346 | rate_limit 11 (100.0%) | 0.0% |
| 3 | 0 | 0 | 0 | 0 | none | - |

- First 429 at: 2 RPS (n=11 in that step).
- 429 here means our per-client limit (class rate_limit) or the provider's, after the gateway's retries; the dashboard separates them (retries and fallbacks are on its own panels).
- Outcome classes counted: ok, ok_fallback, rate_limit, timeout, provider_5xx, schema_fail, bad_request, circuit_open, unauthorized, no_answer, other.
