# Dispatch SLOs

An **SLI** is a measurement (the share of requests that got an answer). An
**SLO** is the target for it (99% over 7 days). The **error budget** is what
the target leaves over: at 99%, 1 request in 100 may fail. The **burn rate** is
how fast that budget is being spent: 1× uses it up in exactly the 7-day window,
14.4× in under 12 hours.

Every SLI is measured on `/v1/triage` only. A client's own mistake (any 4xx:
bad body, wrong key, over its rate limit) counts neither way. The baselines are
from `results/baseline.json`: prompt v2 on Gemini (`gemini-3.5-flash-lite`),
the golden test split, n = 74 uncached calls, price table of 2026-10-27.

| SLO | Target | Baseline | Why this number |
|---|---|---|---|
| Availability | 99% of requests answered (not a 5xx), over 7 days | 100% (74 of 74) | Two free-tier providers at 10 and 15 requests a minute can't promise more; 1% is room for a short outage of both a week. |
| Latency | p95 under 4 s, at 5 RPS | p95 9.6 s on test (n = 74); 1.7 s on dev (n = 198) | Someone triaging a queue waits about as long as a page load; 4 s is above Gemini's typical answer (p50 1.5 s) and below its slow tail. The test-split baseline misses it today: that tail is the first thing to look at. |
| Cost | at most $0.40 per 1,000 successful requests (list price) | $0.284 per 1,000 | Room for about 1 request in 7 going to Cohere, which costs about 4× Gemini ($1.14 per 1,000: prompt v1 on dev, n = 198). |

How each is measured:

- **Availability**: good = HTTP 200; valid = every response that isn't a 4xx.
  A `schema_fail` (502), a provider outage (503) and a timeout (504) are all
  bad. The gateway's fallback answering counts as good: the client got an answer.
- **Latency**: `dispatch_request_duration_seconds` for every request that got
  as far as the model call, retries and fallback included. 4 s is a bucket
  edge, so the share under it is counted, not interpolated.
- **Cost**: list price × tokens, per provider, from `config/models.yaml`. The
  free tiers actually cost $0. The mocks are priced as Gemini and Cohere so a
  drill moves the cost panels.

## Alerts

Both are Grafana-managed rules in `ops/grafana/provisioning/alerting/`.

- **Fast burn**: the burn rate (5xx ratio ÷ 0.01) above 14.4× over the last
  hour *and* over the last 5 minutes, for 2 minutes. 14.4× is the Google SRE
  workbook's page threshold: 2% of a month's budget in one hour. The 5 min
  window confirms it's still happening, so the alert clears soon after a fix.
  Put plainly: more than 14.4% of requests failing over both windows.
- **Cost spike**: cost per minute over the last 5 minutes above 3× its 24-hour
  average, for 10 minutes. Catches a fallback storm, a longer prompt or a
  jump in traffic. It waits until Prometheus has at least 23 hours of data:
  before that the "24-hour average" is a few minutes spread over a day, and
  any traffic would look like a spike.

## The numbers, for the tests

The dashboard and the alert files are checked against this block by
`test/slos.test.ts`, so a number can't change in one place only.

```yaml
availability:
  target: 0.99
  window: 7d
latency:
  p95_seconds: 4
cost:
  per_1000_usd: 0.40
  baseline_per_1000_usd: 0.284
fast_burn:
  factor: 14.4
  long_window: 1h
  short_window: 5m
cost_spike:
  factor: 3
  window: 5m
  baseline_window: 24h
  for: 10m
```
