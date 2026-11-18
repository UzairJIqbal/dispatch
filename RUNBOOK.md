# Dispatch runbook

What to do when Dispatch pages you. Each section says what the alert or
situation means, what to open first, how to stop the damage, how to know it's
over, and when to get help. Every panel named here is on the Grafana dashboard
**Dispatch** (uid `dispatch`); every command runs from a clone of this repo
with `.env` filled in (`.env.example` lists the variables).

**Who.** The on-call person holds this runbook. "Wake the owner" means email or
call the repo owner (the alerts' contact point `dispatch-email` goes to them).

**Words used below.** The *primary* is Gemini, the provider every request tries
first. The *fallback* is Cohere, tried when the primary fails. The *circuit* is
the gateway's switch that stops calling a provider for 30 s after 5 failures in
30 s. *Force-fallback* is a switch in the release config that skips the primary
entirely. A *canary* is a new prompt version on a small share of traffic.

## Where to look

| What | Where |
|---|---|
| Dashboard | Grafana Cloud → Dashboards → **Dispatch**. Production only: Grafana scrapes `dispatch-prod`'s `/metrics`, not staging. |
| Traces | Langfuse → Tracing. Every request is one trace named `triage.request`. Filter by **User ID** (the client's name) or by metadata: `app.error_class`, `app.fallback`, `app.release`, `app.provider`, `app.prompt_version`, `app.aborted`. |
| Logs | `az containerapp logs show -n dispatch-prod -g dispatch --follow` (or `dispatch-staging`). One `request` line per request, plus `gateway.attempt`, `gateway.skip`, `gateway.circuit`, `release.change`, `release.rollback`, `ratelimit.unavailable`. Add `--type system` for Azure's own events (restarts, failed probes). |
| What's live | `pnpm release status --target prod` (or `staging`): the config in Redis, what the service actually serves, which prompts its image has. |
| Is it up | `curl -s $PROD_URL/readyz`: checks config, Redis, provider keys and circuits, and names the one that fails. |
| Synthetic probe | Grafana Cloud → Testing & synthetics → Synthetics → check `dispatch-prod-readyz`. |

## Release switches (no deploy, live within 30 s)

The service re-reads the release config from Redis every 30 s. Each command
prints the config before and after; nothing is rebuilt.

```sh
pnpm release force-fallback on  --target prod   # every request starts on Cohere; Gemini is skipped
pnpm release force-fallback off --target prod   # back to Gemini first
pnpm release rollback           --target prod   # drop the canary: every request on stable
pnpm release status             --target prod   # check: the "serving" line shows what's live
```

While force-fallback is on, `status` shows `FORCE-FALLBACK ON` on the
`serving` line, each request logs `gateway.skip` with `reason: "forced fallback"`,
and **Fallback rate** reads 100%. Cohere's trial key allows 1,000 calls a
month and 15 a minute (Gemini: 10 a minute), so don't leave it on for days.

---

## Alert: fast burn

**Means.** More than 14.4% of `/v1/triage` requests answered 5xx over both the
last hour and the last 5 minutes (burn rate above 14.4×). At that pace the
7-day error budget (1% of requests) is gone in under 12 hours. Severity: page.

**Look first.**
1. **Failed responses by class**: which `error_class` the 5xx are. That picks
   the section to go to:
   - `provider_5xx`, `timeout`, `connection`, `rate_limit` (503) mostly on Gemini → [Primary provider down](#primary-provider-down)
   - `circuit_open` with both circuits open → [Both providers down](#both-providers-down)
   - `schema_fail` → [Schema failures rising](#schema-failures-rising)
   - only on canary requests → [Canary misbehaving](#canary-misbehaving)
2. **Circuit state per provider**: 2 means open (skipped), 1 half-open (one trial request), 0 closed.
3. **Burn rate, 1 h** and **Error budget left**: how much budget is already gone.
4. Langfuse: filter metadata `app.error_class` = the class from step 1 for a few example traces.

**Mitigate.** Follow the section step 1 sent you to.

**Fixed when.** **Availability, rolling 1 h, vs SLO** is back above the 0.99
line and the alert resolves (the 5-minute window clears it within minutes of a fix).

**Wake the owner** if it has fired for 30 minutes and no section above stopped
it, or **Error budget left** drops below 0.

**Blind spot.** A request the client gave up on before we answered is counted
as a 200, so it never moves this alert (postmortem
[001](postmortems/001-drill-requests-unanswered.md), action item 3). If clients
report timeouts and this alert is quiet, look at **Triage latency vs SLO**
(p99 near 30 s) and at Langfuse traces with `app.aborted` = true.

## Alert: cost spike

**Means.** List-price cost per minute over the last 5 minutes is over 3× its
24-hour average, for 10 minutes. The free tiers cost $0 in money; this alert
is about a shift in where requests go or how big they are. Severity: ticket
(look during working hours, don't page).

**Look first.**
1. **Cost per minute (list price)**: which `provider` the cost comes from.
2. **Fallback rate**: Cohere costs about 4× Gemini per request, so a fallback
   storm is the usual cause. If high, go to [Primary provider down](#primary-provider-down).
3. **Tokens per minute**: a jump in `input` tokens with no jump in traffic
   means a longer prompt or longer tickets; in `output`, longer answers.
4. **Requests per second**: more traffic costs more and isn't a fault.
5. Is force-fallback on? `pnpm release status --target prod`. If it was left on, that is the spike.

**Mitigate.**
- Force-fallback left on: `pnpm release force-fallback off --target prod`.
- A new prompt version made answers longer: if it's the canary, `pnpm release rollback --target prod`; if it's stable, `pnpm release` can only point stable at another version the image has (`pnpm release canary <old> 50 --target prod` then `pnpm release promote --target prod` puts the old one back).
- Traffic from one client: [Rate limits from a client](#rate-limits-from-a-client).

**Fixed when.** **Cost per minute (list price)** drops under its own dashed
3× line and the alert resolves.

**Wake the owner**: no. Open an issue with the panel screenshots unless it
comes with a fast-burn page.

## Alert: prod readyz probe

**Means.** Grafana Synthetic Monitoring's check `dispatch-prod-readyz` got a
failing `/readyz` from most of its 3 locations for 4+ minutes. Production is
down or not ready, as seen from outside. Severity: page.

**Look first.**
1. `curl -s --max-time 30 $PROD_URL/readyz`. A JSON body names the check that fails:
   - `redis` → Upstash is down or its token changed. Triage still answers
     (the rate limit lets requests through, logged as `ratelimit.unavailable`),
     but release changes don't arrive. Check console.upstash.com.
   - a provider key → the key was revoked or expired; see [Both providers down](#both-providers-down).
   - a circuit → [Primary provider down](#primary-provider-down) or [Both providers down](#both-providers-down).
   - no answer at all → the app itself, step 2.
2. `az containerapp revision list -g dispatch -n dispatch-prod -o table`: is a revision running and healthy?
3. `az containerapp logs show -n dispatch-prod -g dispatch --type system`: crash loops, failed probes, image pull errors.
4. Synthetics → `dispatch-prod-readyz`: failing from one location only is a network problem on that path, not ours.

**Mitigate.**
- App crashing after a promote: promote the previous commit again (Actions →
  promote → Run workflow, tag = the last good sha from `git log`). It
  deploys that image by digest; nothing is rebuilt.
- Azure out of credit: Azure for Students stops services when the credit runs
  out. Check portal.azure.com → Subscriptions → Azure for Students. Only the
  owner can fix this.
- Redis: nothing to do on our side; it recovers by itself and the service
  re-reads the config within 30 s.

**Fixed when.** `curl -s $PROD_URL/readyz` answers 200 with every check `ok`,
the Synthetics check is green, and the alert resolves.

**Wake the owner** right away if the app isn't running at all, or the cause is
Azure credit or an expired key: those need their accounts.

---

## Primary provider down

**Means.** Gemini is failing (outage, 5xx, slow, out of quota) or so slow
that requests queue. With a hard outage the gateway handles it by itself:
after 5 failures in 30 s Gemini's circuit opens and requests go to Cohere for
30 s at a time. Force-fallback is for the case the circuit doesn't catch: a
slow or saturated Gemini, where requests wait instead of failing.

**Look first.**
1. **Fallback rate**: rising means Cohere is answering for Gemini.
2. **Circuit state per provider**: Gemini at 2 (open) means a hard outage the gateway is already routing around.
3. **Gateway errors by class**: what Gemini returns (`rate_limit`, `provider_5xx`, `timeout`).
4. **Provider attempt latency p95**: Gemini slow without errors.
5. **Triage latency vs SLO**: p99 near 30 s means requests are queuing for Gemini's 10-a-minute pace.
6. Langfuse: filter metadata `app.fallback` = true, and open a slow trace: a long `gateway.pace_wait` child span is time spent in our own queue.
7. Logs: `gateway.attempt` lines with `provider: "gemini"` and their `error_class`.

**Mitigate.**
- Circuit already open and Cohere answering: nothing to do; watch it.
- Gemini slow, failing intermittently, or a queue building:
  `pnpm release force-fallback on --target prod`. Within 30 s new requests go
  straight to Cohere.
- `rate_limit` from Gemini all day long: the free daily quota is used up
  (everything on the key shares it: probe, smoke tests, evals). It resets
  at midnight Pacific time. Force-fallback until then, and don't run `pnpm eval`
  on that key.

**Fixed when.** With force-fallback on: **Fallback rate** near 100%,
**Failed responses by class** flat, **Triage latency vs SLO** p95 back to its
usual. Then turn it off when Gemini is healthy again:
`pnpm release force-fallback off --target prod`, and watch **Fallback rate**
drop to near 0 within a minute.

**Wake the owner** if Cohere fails too (go to [Both providers down](#both-providers-down)),
or force-fallback has been on for more than a day (Cohere's trial is 1,000 calls a month).

**No alert for this.** While Cohere holds, availability stays fine, so nothing
pages. It shows only on **Fallback rate** and the cost panels; the cost spike
alert catches a long one.

### Game day: primary provider down (staging)

A game day is a practice incident: break it on purpose, follow this section,
and time how long it takes. Staging isn't on the dashboard, so the traffic
script's output and the staging logs are the signals.

1. Staging must run an image with the switch: `pnpm release status --target staging`
   must *not* say "this image has no force-fallback switch".
2. Start the logs in one terminal: `az containerapp logs show -n dispatch-staging -g dispatch --follow`.
3. Start traffic above Gemini's 10-a-minute pace in another (real calls,
   about 120 in 10 minutes, half to each provider once mitigated):
   `pnpm traffic --url $STAGING_URL --mix messy --rate 0.2 --duration 600 --real`.
   Write down the start time: **T0**.
4. **T_alert**: the first traffic line with `no answer in 30 s`, or a request
   log line with `"aborted":true`. This is the "alert": the moment a person
   watching would know something is wrong.
5. Mitigate: `pnpm release force-fallback on --target staging`. Write down the time: **T_mitigation**.
6. Confirm: the traffic lines start showing `200 fallback`, and the logs show
   `gateway.skip` with `"reason":"forced fallback"`. Write down when the first one appears: **T_confirmed**.
7. Clean up: `pnpm release force-fallback off --target staging`.

| Date | T0 | T_alert | T_mitigation | T_confirmed | Alert → mitigation | Notes |
|---|---|---|---|---|---|---|
| _not run yet_ | | | | | | |

## Both providers down

**Means.** Gemini and Cohere both fail, so requests answer 503 (`circuit_open`,
`provider_5xx`, `connection`, `auth`, `rate_limit`) or 504 (`timeout`). There
is no third provider; the fast-burn alert fires.

**Look first.**
1. **Circuit state per provider**: both at 2 (open).
2. **Gateway errors by class**: the class per provider. `auth` means a key, not an outage.
3. `curl -s $PROD_URL/readyz`: names the failing key or circuit.
4. Langfuse: filter metadata `app.error_class` = `circuit_open`, then open the
   last trace before it to see each provider's own error on its `gen_ai.chat` spans.
5. The providers' status pages: aistudio.google.com/status and status.cohere.com.

**Mitigate.**
- `auth` on one provider: its key was revoked or expired. Make a new one
  (aistudio.google.com/apikey or dashboard.cohere.com/api-keys), then put it
  in the app's secret: `az containerapp secret list -g dispatch -n dispatch-prod -o table`
  shows the secret names; `az containerapp secret set -g dispatch -n dispatch-prod --secrets <name>=<new key>`,
  then `az containerapp revision restart -g dispatch -n dispatch-prod --revision <active revision>`.
  Never paste a key into a log, issue or commit.
- A real outage of both: nothing to switch to. Turn force-fallback off if it's on
  (so Gemini gets tried first again), and tell clients to retry with backoff.
- Daily quota on Gemini plus Cohere's monthly trial both spent: wait for the
  reset (Gemini midnight Pacific; Cohere at the month's start). Only the owner
  can add a key.

**Fixed when.** **Circuit state per provider** back to 0 for at least one
provider, **Failed responses by class** flat, and `/readyz` 200.

**Wake the owner** right away: this is a full outage, and the likely fixes
(new keys, quota) need their accounts.

## Schema failures rising

**Means.** The model's answers fail our JSON schema. Each one gets one repair
call; still broken, the client gets 502 `schema_fail`. Usual causes: a new
prompt version, a provider changing its model behind an alias, or a ticket
pattern that confuses the prompt.

**Look first.**
1. **Repairs and schema failures**: repairs rising is the early sign;
   failures mean repairs stopped working. Which `provider`?
2. **Schema-valid rate, by release**: canary only, or stable too?
3. Langfuse: filter metadata `app.error_class` = `schema_fail`, and
   `app.prompt_version` / `app.provider` to see what they share. The
   `gateway.repair` child span marks a repair. (Ticket text is never in a
   trace; the labels the model gave are its output.)

**Mitigate.**
- Canary only: `pnpm release rollback --target prod`.
- One provider only (a model change behind the alias):
  - Gemini: `pnpm release force-fallback on --target prod`.
  - Cohere: nothing to switch; it only answers when Gemini fails, so it hurts only then.
- Both providers, on stable: the prompt itself. Put the previous version back
  (`pnpm release canary <previous> 50 --target prod`, then `pnpm release promote --target prod`), and open
  an issue for a prompt fix that goes through the eval gate.

**Fixed when.** **Repairs and schema failures** back near 0 and
**Schema-valid rate, by release** back to its usual on every release.

**Wake the owner** if failures pass 5% of requests and none of the above stops them.

## Canary misbehaving

**Means.** The canary prompt version is worse than stable on latency, errors
or schema-valid answers. The service checks every minute and rolls back by
itself (`release.rollback` in the logs, an **Auto-rollback** marker on the
dashboard), but only after 50 canary requests in its 10-minute window. On the
free tier a small canary rarely gets there, so act by hand.

**Look first.**
1. The **Canary vs stable** row: **Error rate, by release**, **p95 latency, by release**,
   **Schema-valid rate, by release**, and **Requests per second, by release**
   for how many requests the canary has seen (a few bad requests is noise).
2. Markers on those panels: **Release change** (when it started) and **Auto-rollback**.
3. `pnpm release status --target prod`: which version is the canary and at what share.
4. Langfuse: filter metadata `app.release` = `canary`, compare with `stable`.

**Mitigate.** `pnpm release rollback --target prod`. If the auto-rollback
already ran, there is nothing to undo: `status` shows `canary none`.

**Fixed when.** `pnpm release status --target prod` shows `canary none` on the
`serving` line, and **Requests per second, by release** shows no canary
traffic a minute later.

**Wake the owner**: no, unless the rollback command fails (Redis down: the
command says so) and the canary keeps answering.

## Rate limits from a client

**Means.** One client sends more than 60 requests a minute and our limiter
answers 429 `rate_limit` with `Retry-After`. That's the limit working; it
counts as the client's error, not against the SLO. Don't confuse it with a
503 `rate_limit`, which is Gemini's quota (see
[Primary provider down](#primary-provider-down)).

**Look first.**
1. **Failed responses by class**: `rate_limit` with status 429.
2. Langfuse: filter **User ID** = the client's name to see its volume.
   Logs: `request` lines with `"status":429` carry the `client`.

**Mitigate.**
- A client retrying in a tight loop: tell them to wait for `Retry-After`.
- The limit is the same for every client (60 a minute) and can't be lowered for one
  client without a code change. To cut off an abusive or leaked key, revoke it: list the app's
  secrets (`az containerapp secret list -g dispatch -n dispatch-prod -o table`),
  set the client-keys secret again without that client's `name:hash` line
  (`az containerapp secret set ...`), and restart the revision
  (`az containerapp revision restart ...`). Give the client a new key with
  `pnpm client-key <name>` if they should keep access.

**Fixed when.** **Failed responses by class** shows no 429 from that client,
or the revoked key gets 401 `unauthorized` in the logs.

**Wake the owner**: no. Mention it in the next issue unless the key leaked
publicly, then revoke first and tell the owner the same day.

## Staging asleep or crashing

**Means.** `dispatch-staging` scales to zero when idle. The first request
after a quiet spell waits for a cold start; that's normal, not an incident.
Crashing means it never gets ready: the deploy workflow's `/readyz` wait fails,
or requests keep failing after a minute.

**Look first.**
1. `curl -s --max-time 90 $STAGING_URL/readyz`: asleep answers after a cold
   start; a JSON body names any failing check.
2. `az containerapp revision list -g dispatch -n dispatch-staging -o table`: running, provisioning or failed.
3. `az containerapp logs show -n dispatch-staging -g dispatch --type system`:
   image pull errors, failed probes, restarts. Then `--type console` for the app's
   own error at startup: a missing variable names itself and says where it goes.
4. GitHub → Actions → `deploy`: the last run's step that failed.

**Mitigate.**
- Asleep: nothing; the first request wakes it.
- A bad image: deploy the last good one,
  `az containerapp update -g dispatch -n dispatch-staging --image ghcr.io/uzairjiqbal/dispatch:<last good sha>`.
- A missing or wrong secret: set it with `az containerapp secret set` as in
  [Both providers down](#both-providers-down), then restart the revision.

**Fixed when.** `/readyz` answers 200 naming the expected commit (`git_sha`)
and `pnpm smoke --url $STAGING_URL` passes (3 real calls).

**Wake the owner**: never for staging alone. Production is a separate app.
