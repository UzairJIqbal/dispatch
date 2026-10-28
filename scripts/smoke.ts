import { setTimeout as sleep } from "node:timers/promises";
import { loadEnv } from "../src/env.js";
import { loadSplit } from "../src/eval/command.js";
import { ReadySchema, checkAnswer, parseSmokeArgs, pick, readyOn } from "../src/smoke/smoke.js";
import { run } from "./run.js";

// `pnpm smoke --url <service> [--sha <commit>] [--count 3]`: the deploy job
// runs it against staging (3 tickets, on the commit just built); the
// synthetic probe runs it against production (1 ticket, any commit).
// Dev-split tickets only: the test split is for grading. The output names
// ticket ids, never their text, because Actions logs are public.

// A cold Render free instance takes about a minute to answer its first request.
const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 10_000;
// Longer than the gateway's own 20 s budget, so the service always answers first.
const REQUEST_TIMEOUT_MS = 30_000;

run(async () => {
  loadEnv();
  const args = parseSmokeArgs(process.argv.slice(2));
  const key = process.env.SMOKE_KEY;
  if (args.count > 0 && !key) {
    throw new Error("SMOKE_KEY is not set: a client key the service knows (from `pnpm client-key smoke`). In Actions it comes from a repository secret.");
  }

  // Wait until /readyz is 200 on the right commit. Render keeps the old
  // instance serving while the new one starts, so "ready" alone isn't enough.
  const deadline = Date.now() + args.waitS * 1000;
  const want = args.sha ? ` on ${args.sha}` : "";
  console.log(`Waiting up to ${String(args.waitS)} s for ${args.url}/readyz${want}`);
  for (;;) {
    let seen: string;
    try {
      const res = await fetch(`${args.url}/readyz`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
      const body = ReadySchema.safeParse(await res.json().catch(() => undefined));
      if (body.success && readyOn(body.data, res.status, args.sha)) {
        console.log(`Ready on ${body.data.git_sha}.`);
        break;
      }
      seen = body.success ? `${String(res.status)} ${body.data.status} on ${body.data.git_sha}${body.data.failing ? ` (failing: ${body.data.failing.join(", ")})` : ""}` : `HTTP ${String(res.status)}`;
    } catch (err) {
      seen = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() + POLL_MS > deadline) throw new Error(`${args.url} was not ready${want} after ${String(args.waitS)} s. Last answer: ${seen}`);
    console.log(`  not yet: ${seen}`);
    await sleep(POLL_MS);
  }
  if (args.count === 0 || !key) return;

  const { rows } = await loadSplit("dev");
  if (rows.length === 0) throw new Error("The dev split is empty. `pnpm golden:import` fills the golden set.");
  const failures: string[] = [];
  for (const row of pick(rows, args.count)) {
    const started = performance.now();
    let problem: string | undefined;
    let line = "";
    try {
      const res = await fetch(`${args.url}/v1/triage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ text: row.text, ticket_id: row.id }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await res.json().catch(() => undefined);
      const checked = checkAnswer(res.status, body, args.sha);
      if (checked.ok) {
        const { category, priority, meta } = checked.answer;
        line = `${category} / ${priority}, ${meta.provider}${meta.fallback ? " (fallback)" : ""}, ${meta.git_sha}`;
      } else problem = checked.problem;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    const ms = Math.round(performance.now() - started);
    console.log(`  ${problem ? "FAIL" : "ok  "} ${row.id}  ${String(ms)} ms  ${problem ?? line}`);
    if (problem) failures.push(`${row.id}: ${problem}`);
  }
  if (failures.length > 0) throw new Error(`Smoke test failed, ${String(failures.length)} of ${String(args.count)}:\n${failures.join("\n")}`);
  console.log(`Smoke test passed: ${String(args.count)} of ${String(args.count)} tickets answered.`);
});
