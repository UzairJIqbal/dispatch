# Canary drill (Phase 9)

**When:** 2026-11-18, 03:15–03:25 PKT. **Where:** staging (`c0a1383`), real Gemini with
Cohere as fallback. **What:** `pnpm release canary v1 10`, then `pnpm traffic --mix messy
--rate 0.15 --duration 600 --real` (half the tickets messy), then `pnpm release rollback`.
Raw output: [results/drill.txt](../results/drill.txt). Recorded on video.

## Numbers

| | Value | n |
|---|---:|---:|
| Requests sent | 89 | 89 |
| Answered | 61 (52 primary, 9 by the fallback) | 89 |
| No answer within the client's 30 s | 28 (31%) | 89 |
| Answered by the canary (v1) | 5 of 61 = 8.2% (weight 10%) | 61 |
| Auto-rollback | none: 5 canary requests, the criteria need 50 | 5 |
| Manual rollback | config written, the service served only stable within 30 s | — |

All 39 requests in the first 4.5 minutes were answered, with no errors. The first
timeout came at 03:20:50; after that the share without an answer grew every
interval, and from 03:24 Cohere answered 9 requests.

## Findings

1. **Routing works.** 8.2% canary against a 10% weight is within chance at n=61
   (the 10,000-request simulation in the tests gives 9–11%).
2. **Rollback works.** After `pnpm release rollback` the service re-read the config and
   served stable only within one 30 s refresh. Nothing was rebuilt or redeployed.
3. **On the free tier the auto-rollback can't judge a 10% canary.** Gemini is paced to 10
   calls a minute, so a 10-minute window holds about 100 requests at most, about 10
   canary at a 10% weight. The 50-request minimum is never reached, so the auto-rollback
   waits forever, as designed: it never judges on noise. To be judged here a canary needs
   a longer window or a larger weight (or a paid quota). The criteria are left as the spec
   wrote them; changing them is a decision, not a fix.
4. **The queue in front of Gemini has no limit.** At 0.15 RPS (9 a minute) traffic is just
   under the 10-a-minute pacing, but retries and fallbacks take slots too, so the queue
   grew and the client gave up on 31% of requests at 30 s. The wait for a free-tier slot
   doesn't count against the gateway's 20 s deadline (on purpose, `src/gateway/gateway.ts`),
   so a queued request waits rather than failing fast. This is the same limit load test 2
   found at 0.5 RPS. A cap on the queue wait, answering `rate_limit` 503 instead, would
   give a client a fast answer it can retry. Not built.
5. The auto-rollback itself was drilled on the mock (canary only slowed with
   `MOCK_CANARY_MODE=slow`): rolled back after the 50th canary request, canary p95 8.13 s
   against stable 0.004 s (n=50 canary, 61 stable). See the README, "Canary release".
