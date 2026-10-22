# Phase 7 — Deploy

## Goal

Dispatch runs on the internet in two places, staging and production, from the same Docker image. Production's metrics are on a Grafana Cloud dashboard, a synthetic probe keeps it awake and gives the SLOs data, and the alerts email you.

## Where this starts

Everything works in docker compose on your machine. Nothing is deployed. You'll need free accounts on Render and Grafana Cloud, and a GitHub repo for the project (public, for free Actions minutes).

## Build

- **A GitHub Actions workflow** that, on every push to main, builds the image, tags it with the git sha and pushes it to GitHub Container Registry.
- **Two Render web services from that image**: `dispatch-staging` and `dispatch-prod`, each with its own env vars, client keys and Upstash database (or key prefix). Health check path `/readyz`.
- **Staging deploys automatically** after the image is pushed: the workflow triggers Render, waits for `/readyz`, then runs a smoke test of 3 real tickets.
- **Production is promoted by hand**: a `workflow_dispatch` action that takes an image tag (default: the one on staging) and deploys exactly that image. No rebuild.
- **Grafana Cloud**: the "metrics endpoint" integration scrapes production's `/metrics` with basic auth. The dashboard JSON from Phase 6 is imported. The two alert rules are created there and email you.
- **The synthetic probe**: a scheduled GitHub Action that calls production's `/readyz` every 10 minutes and sends one real triage request every 30 minutes with a dedicated `probe` client key. It fails loudly in Actions if the probe fails.
- **Check the current free limits** of Render (instance hours, sleep), Grafana Cloud (series, retention) and GitHub Actions, and write the ones that matter in the README draft.

## Constraints

- **The same image runs in staging and production.** Only the environment differs.
- **No secret in the workflow files or the image.** GitHub secrets and Render env vars only.
- **Production stays on free plans.** If a free limit would be hit, tell me before changing anything.
- Staging may sleep. Production is kept awake only by the probe.
- `/metrics` is never open without the password on the internet.

## Acceptance check

1. Push a commit to main. Actions builds the image, staging deploys, the smoke test passes, and staging's `meta.git_sha` is that commit.
2. Run the promote action. Production serves the same `git_sha`, and the image wasn't rebuilt (same digest).
3. `curl` production with a client key. A valid answer. Without the key: 401.
4. Open `/metrics` on production without the password: 401.
5. Grafana Cloud's dashboard shows production's probe traffic after an hour.
6. Remove production's Cerebras key in Render for 15 minutes. The probe still passes through the fallback, and the dashboard shows the fallback rate jump. Put the key back.

## Not in this phase

The eval gate in CI (next phase). Canary releases.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
