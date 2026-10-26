# Phase 8 — The eval gate in CI

## Goal

A pull request that makes the AI worse cannot be merged: CI runs the test split, compares it with main's baseline, and blocks the PR with a table saying exactly which number got worse and by how much.

## Where this starts

Deploys work from main. Nothing checks a pull request, so a worse prompt would go straight to staging.

## Build

- **`ci.yml` on every pull request**: install, type-check, lint, tests (mock only, no real calls) and a gitleaks secret scan.
- **`eval-gate.yml`** on pull requests that change prompts, the model config, or the triage, grading or gateway code. It runs `pnpm eval --split test` on the candidate with real calls.
- **The baseline from main**: every green push to main runs the same eval and keeps its result as a CI artifact. The gate compares against the latest one. The response cache is kept between runs with `actions/cache`, keyed by a hash of the prompts and config, so an unchanged rerun spends nothing.
- **The rules**, all in one config file, each checked separately:
  - both-correct accuracy dropped by more than the threshold (2 points, or the noise floor from the baseline if larger)
  - any new dangerous miss
  - schema-valid rate dropped by more than 2 points
  - p95 latency rose by more than 15%
  - cost per request rose by more than 15%
- **The table**: baseline, candidate, change and pass/fail for each rule, with n. Below it, both-correct per slice (baseline vs candidate, with n) for information only; slices are too small to gate on. Posted as one PR comment that is updated on each push (not a new comment each time), and in the job summary.
- **Branch protection** on main: both workflows must pass to merge.
- **Without the provider secret** (a PR from a fork), the gate says "skipped: no key" and fails, never passes silently.
- **Promote the baseline**: after a PR that changed the prompt merges, the main run's result becomes the new baseline; `results/baseline.json` in the repo is updated by you for each release, for the README.

## Constraints

- **The gate grades on test only, and nothing in the PR can change which tickets are in test.** A PR that edits the golden set without bumping its version fails.
- **Never loosen a rule to get a PR through.** If a rule looks wrong, tell me and show the table.
- The gate prints its call count. Latency rules use uncached calls only; if every call was cached, the latency rule says "not measured" instead of passing.
- This phase goes through a pull request with CodeRabbit before merging.

## Acceptance check

1. Open a PR that only changes the README. `ci.yml` runs, `eval-gate.yml` doesn't.
2. Open a PR with a better or equal prompt. The gate runs, posts the table, and passes.
3. Open a PR with a deliberately worse prompt (for example, remove the priority rules). The gate fails, the table shows which rules failed with the numbers, and the merge button is blocked. **Keep this PR's link** for the README.
4. Push a second commit to that PR. The same comment is updated, not a new one.
5. Rerun the passing PR's gate with nothing changed. It finishes quickly from the cache, and latency says "not measured".
6. Add a fake key like `sk-test-1234567890abcdef` to a file in a PR. gitleaks fails the PR.

## Not in this phase

Canary releases and rollback (next phase).

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
