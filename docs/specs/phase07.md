# Phase 7 — Deploy

## Goal

Dispatch runs on the internet in two places, staging and production, from the same Docker image. Production's metrics are on a Grafana Cloud dashboard, a synthetic probe checks it and gives the SLOs data, and the alerts email you.

## Hosting change (2026-11-01)

Render now asks for a card before creating any service, so staging and production move to **Azure Container Apps on Azure for Students** (no card, a yearly credit). Everything below that says Render means that host: two container apps from the same image, health probe `/readyz`, env vars and secrets set on the app, and Actions deploying by digest with a short-lived login (OIDC), never a stored password. Production runs one always-on replica at the smallest size; staging scales to zero. Production is paid from the student credit, so the README shows its estimated monthly cost with the date of the price table. The account activated on 2026-11-13; region is Malaysia West, because the student subscription only allows a short list of regions.

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
- Staging may sleep (it scales to zero). Production keeps one replica always on.
- `/metrics` is never open without the password on the internet.

## Acceptance check

1. Push a commit to main. Actions builds the image, staging deploys, the smoke test passes, and staging's `meta.git_sha` is that commit.
2. Run the promote action. Production serves the same `git_sha`, and the image wasn't rebuilt (same digest).
3. `curl` production with a client key. A valid answer. Without the key: 401.
4. Open `/metrics` on production without the password: 401.
5. Grafana Cloud's dashboard shows production's probe traffic after an hour.
6. Break production's Gemini key (set it to a wrong value on the app; removing it stops startup) for a few minutes. The probe still passes through the fallback, and the dashboard shows the fallback rate jump. Put the key back.

## Not in this phase

The eval gate in CI (next phase). Canary releases.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.

## Acceptance result (2026-11-13)

Run by Claude at the user's request, with the user asleep. Sample sizes are small.

1. Deploy run on f475c9e: image built, staging updated, 3 smoke tickets passed, staging `/readyz` named f475c9e.
2. Promote: production runs the same digest as staging (`sha256:c59f11f8…`, checked on both apps), not rebuilt.
3. `curl` with a client key: valid triage answer (n=1). Without the key: 401 (n=1).
4. `/metrics` without the password: 401 (n=1).
5. Grafana Cloud has `dispatch_*` series from production, scraped every minute (job `integrations/metrics_endpoint/…-dispatch`). The scheduled probe has not run yet: GitHub had not started the cron an hour after the workflow was re-enabled. Only two manual probe runs exist, so "probe traffic after an hour" is **not yet confirmed**.
6. Gemini key set to a wrong value for about 1.5 min and again for about 3 min, with a manual probe run in the second. Probe passed through Cohere (3 of 3 direct requests had `fallback: true`); Grafana showed `increase(dispatch_fallbacks_total[30m])` at 4.1 against 150 requests (baseline: 0 fallbacks before the drill). Shorter than the 15 minutes the spec first asked for. Key restored; the next request was served by Gemini with `fallback: false`.

