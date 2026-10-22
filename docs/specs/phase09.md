# Phase 9 — Canary and rollback

## Goal

A new prompt version goes live to 10% of traffic first, the dashboard compares it with stable side by side, and if it breaks the rollback criteria written before it started, it is rolled back automatically within about a minute, with no rebuild and no redeploy.

## Where this starts

Every release goes to 100% of traffic at once, and the live prompt version is fixed when the service starts. Rolling back means a revert and a redeploy.

## Build

- **The release config in Upstash**: `stable`, `canary` (version and weight, or none) and `criteria`, validated with Zod. The service re-reads it every 30 seconds. The file from Phase 3 stays as the default when Redis is empty.
- **Routing**: each request goes to the canary with the configured probability. `meta`, logs, traces and metrics carry `release` = `stable` or `canary`.
- **Dashboard panels** comparing stable and canary: requests, p95, error rate, schema-valid rate, and a marker for each release event.
- **Rollback criteria** in the config, written before the canary starts: minimum 50 canary requests, then roll back if canary p95 > 1.25× stable, canary error rate > stable + 2 points, or canary schema-valid < 95%.
- **Automatic rollback**: every minute the service compares the canary with stable over the last 10 minutes. If a criterion is broken, it sets the canary to none, logs one `release.rollback` event with the numbers, and increments a rollback metric.
- **`pnpm release`** with `status`, `canary <version> <weight>`, `promote` (canary becomes stable), `rollback` and `set-criteria`. Each prints the config before and after. It refuses a version whose prompt file doesn't exist in the deployed image.
- **The drill**: make a version that passes the CI gate but breaks on messy, real-looking traffic (for example, a prompt that stops handling Roman Urdu or two-problem tickets). Run `pnpm traffic` against staging with the messy mix, start it as a 10% canary, and let the automatic rollback catch it. **Record a 2-minute screen video.**

## Constraints

- **Criteria first.** `pnpm release canary` refuses to start without criteria in the config.
- **No rebuild, no redeploy for any release action.** Only a config change.
- **Only one canary at a time.**
- Auto-rollback runs in one place only, so two instances can't fight. (We run one instance; write down how you'd handle more.)
- Tests on the mock: routing share within tolerance over 10,000 simulated requests, each criterion triggering a rollback, the minimum-request rule.

## Acceptance check

1. `pnpm release canary v3 10` on staging, then `pnpm traffic` for 10 minutes. About 10% of requests have `release: canary`, and the dashboard shows both side by side.
2. `pnpm release rollback`. Within 30 seconds every request is stable again. No deploy happened.
3. Start a canary with the mock set to `slow` for canary traffic only. After 50 canary requests, the auto-rollback fires, the log shows the numbers, and the dashboard marks it.
4. Try `pnpm release canary v9 10` for a version that doesn't exist. Refused.
5. Run the drill on staging and record it. The canary passed CI and was rolled back automatically.
6. Write the drill's findings down (what passed CI and why, what caught it). They become the postmortem in Phase 11.

## Not in this phase

Load tests and cost (next phase). Shadow deployments.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
