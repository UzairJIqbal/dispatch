# Dispatch staging: 28 of 89 requests got no answer within 30 s during the canary drill

| | |
|---|---|
| **Incident date** | 2026-11-18 |
| **Duration** | about 5 minutes: first unanswered request 03:20:40 PKT, traffic stopped about 03:25:50 PKT |
| **Severity** | unassigned (Dispatch has no severity scale yet) |
| **Status** | Draft: the open action items are not yet filed as issues |

## Summary

During the Phase 9 canary drill on staging, 28 of 89 triage requests (31%)
got no answer within the client's 30 s. All 39 requests in the first 4.5
minutes were answered; then the share without an answer grew every 10 s until
the traffic stopped. The cause: the gateway queues requests in front of
Gemini's free-tier pace (10 calls a minute) with no limit on how long they
wait, and that wait doesn't count against the gateway's 20 s deadline, so a
queued request waits instead of failing fast. It ended because the drill's
traffic stopped, not because of a fix. The queue is still unbounded.

## Impact

Numbers from the traffic script's output, [results/drill.txt](../results/drill.txt)
(one line every 10 s), and [docs/canary-drill.md](../docs/canary-drill.md).

| | Value | n |
|---|---:|---:|
| Requests sent | 89 | 89 |
| Answered by Gemini (primary) | 52 | 89 |
| Answered by Cohere (fallback) | 9, all after 03:24:00 | 89 |
| No answer within 30 s | 28 (31%) | 89 |
| Minutes with unanswered requests | about 5 (03:20:40 to the end of traffic) | — |
| Longest stretch with no answer at all | 2 min 20 s (03:21:40 to 03:24:00: the answered count stayed at 46) | — |

**Error budget.** Staging isn't scraped by Grafana Cloud, so no dashboard
panel recorded this; the numbers below are computed from the traffic output.
Against the 99% availability SLO (1% of requests may fail), 31% bad is a burn
rate of about 31×, over the 14.4× fast-burn page threshold. Over the 7-day
window at this traffic level (about 9 requests a minute, about 90,000 a
week), 28 bad requests would use about 3% of the budget.

**But our own metrics would have counted these 28 as good.** A request the
client gives up on is recorded when its connection closes, before we have set
a status, so it is counted as a 200 (see Root cause, factor 3). Had this
happened in production, the availability SLI would have read close to 100%
and the fast-burn alert would not have fired.

**Who.** Synthetic drill traffic on staging only. No real client, no
production traffic. No data loss: the service stores nothing but a response cache.

## Timeline

All times PKT (UTC+5), 2026-11-18. Source: [results/drill.txt](../results/drill.txt)
unless noted. Service logs from the drill were not saved.

| Time | Event |
|---|---|
| before 03:15 | Canary v1 at 10% set on staging with `pnpm release canary v1 10` ([docs/canary-drill.md](../docs/canary-drill.md)). |
| 03:15:50 | Traffic starts: `pnpm traffic --mix messy --rate 0.15 --duration 600 --real` (0.15 requests a second, about 9 a minute). |
| 03:15:50 – 03:20:30 | Every request answered: n=40, 200: 40. |
| 03:20:40 | First request with no answer within 30 s (n=42, unanswered 1). |
| 03:21:40 | Answered count reaches 46 and stays there. |
| 03:22:50 | Unanswered: 14 of 60. |
| 03:24:00 | First answers from the fallback (2). Answered count moves again. Why Cohere started answering then isn't recorded: no service logs. |
| 03:24:10 | Unanswered reaches 26. It stays at 26 until 03:25:30. |
| 03:25:30 | Last progress line: n=86, 200: 51, fallback: 9, unanswered: 26. |
| about 03:25:50 | Traffic ends (600 s). Final: n=89, 200: 52, fallback: 9, unanswered: 28. |
| after the traffic | `pnpm release rollback`: the service served only stable within one 30 s refresh ([docs/canary-drill.md](../docs/canary-drill.md)). Exact time not recorded. |

[docs/canary-drill.md](../docs/canary-drill.md) puts the first timeout at
03:20:50; the raw output shows it at 03:20:40.

## Root cause and contributing factors

**Root cause.** The gateway paces Gemini to its free tier, 10 calls a minute,
by making each request wait for a free slot (`provider.pace()` in
`src/gateway/gateway.ts`). That queue has no length limit and no time limit,
and the time spent in it is subtracted from the gateway's 20 s deadline on
purpose, so the deadline measures the provider, not our queue. At 9 requests
a minute the traffic was just under the pace, but retries, repair calls and
fallbacks take slots too, so the queue grew faster than it drained. Requests
waited in it past the client's 30 s, and the client gave up.

Each part was correct on its own terms: the pacer stops us from getting 429s
from Gemini, and the deadline is honest about provider latency. The defect
lived between them: nothing bounds the total time a request can spend before
it gets an answer or an error.

**Contributing factors.**

1. **The pacing wait is outside the deadline.** A request can wait any length
   of time for a slot and still get its full 20 s after that.
2. **An abandoned request keeps its place.** When the client disconnects, the
   request keeps waiting for its slot and still spends a Gemini call. The client's
   disconnect isn't passed to the gateway, so each abandoned request made the
   queue longer for the next ones.
3. **An abandoned request counts as a 200.** The request metric is written
   when the connection closes. A client that disconnects before we answer
   leaves the status at Express's default of 200, so
   `dispatch_requests_total` counts it as good. The latency histogram does see
   it (about 30 s), and its trace has `app.aborted: true`, but the
   availability SLI and the fast-burn alert are blind to it.
4. **Staging isn't on the dashboard.** Grafana Cloud scrapes production only,
   so nothing on staging could have alerted, even with factor 3 fixed.
5. **The golden set had few messy tickets to test on.** Half of the drill's
   traffic was messy tickets (typos, Roman Urdu, no punctuation). The test
   split had 10 messy tickets, too few to say how a prompt does on that kind of
   traffic. This didn't cause the timeouts, but it was a gap the drill made
   visible.

**Which check missed it, which caught it.** The unit tests and the mock load
test (test 1, 50 requests a second) don't model a pace that is slower than the
traffic, so they couldn't see it. Load test 2 on staging (2026-11-17) did see
it at 0.5 requests a second: 10 of 15 waited past 30 s. It was written down
as the free tier's ceiling, not as a defect, so it reached the drill.

## Wrong turns during the response

None recorded. Nobody responded during the drill: the traffic ran to its
planned end, and the timeouts were analysed afterwards from the output.

## What went well

- The canary split worked: 5 of 61 answers (8.2%) came from v1 at a 10%
  weight, within chance at that n.
- `pnpm release rollback` reached the service within one 30 s refresh, with
  no rebuild or redeploy.
- The traffic script reported unanswered requests separately from errors,
  every 10 s, which is the only reason this incident has a timeline.

## What went badly

- A third of requests got no answer, and nothing in our own metrics would
  have shown it (factor 3).
- The queue made things worse for everyone queued behind it, because abandoned
  requests kept their slots (factor 2).
- No service logs were saved, so why the fallback started answering at
  03:24 can't be explained.
- Load test 2 had already shown the same limit the day before; it was noted as
  a capacity number rather than as something to fix.

## Action items

| # | Outcome | Owner | Acceptance check | Status |
|---|---|---|---|---|
| 1 | The golden set has enough messy tickets to compare prompts on that kind of traffic. | Dataset owner | Golden set v3 has 15 new messy tickets, written from the labelling guide before any model saw them; `pnpm golden:stats` shows messy in both splits; the changelog names this postmortem. | **Done** (v3: messy 32 dev, 13 test. Only 3 of the 15 landed in test by the id hash, so the test slice is still small.) |
| 2 | A request never waits longer than a set time for a free-tier slot; past it, the client gets a fast 503 `rate_limit` with `Retry-After` it can act on. | Gateway owner | On the mock, with traffic above the pace, every request gets an answer or a 503 before the client's 30 s, and the 503 count is on **Failed responses by class**. | Open `[to file: gateway owner]` |
| 3 | A request the client abandoned counts as bad in the availability SLI, and stops spending a provider call. | Service owner | On the mock, a client that disconnects at 1 s shows up as bad on **Availability, rolling 1 h, vs SLO**, and its gateway attempt is cancelled (no `gen_ai.chat` span after the disconnect). | Open `[to file: service owner]` |

The runbook's "Primary provider down" section gained the force-fallback switch,
which would have sent new requests straight to Cohere within 30 s
(paced at 15 a minute, above the drill's 9) ([RUNBOOK.md](../RUNBOOK.md#primary-provider-down)).

## Sign-off

_None yet._
