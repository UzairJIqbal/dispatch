// Test 2: a short ramp against STAGING with the real providers, to see where
// the provider starts saying no (429) and how the gateway retries and falls
// back, on the dashboard. Staging only, never production. Spends real model
// calls, so it has a budget: printed first, and a hard stop at 300 requests.
//
// Run:  docker compose --profile load run --rm --no-deps k6 run /work/load/ramp-real.js
import exec from "k6/execution";
import { Counter } from "k6/metrics";
import { loadDevTickets, firstKey, triageOnce, stepThresholds, stepRows, pct, ms, errorsByClass, OUTCOMES } from "./lib.js";

const BUDGET = 300;
const URL = (__ENV.STAGING_URL || "").replace(/\/$/, "");
const KEY = firstKey(__ENV.STAGING_KEY, "STAGING_KEY");
if (!URL) throw new Error("STAGING_URL is not set. Put the dispatch-staging app's URL in .env (see .env.example).");
// A second lock besides the variable's name: the production app is called dispatch-prod.
if (/prod/i.test(URL)) throw new Error(`STAGING_URL (${URL}) looks like production. This test only runs against staging.`);

// Each step is held for HOLD_S. Planned total stays well under the budget, so the
// hard stop below is a second line of defence, not the plan.
const HOLD_S = 30;
const RATES = [0.2, 0.5, 1, 2, 3];
const STEPS = RATES.map((rps, i) => ({ name: `rps_${rps}`, rps, from: i * HOLD_S, to: (i + 1) * HOLD_S }));
const PLANNED = Math.round(RATES.reduce((a, r) => a + r * HOLD_S, 0));
// The test stops by itself once this many 429s have come back: "ramp until 429s appear".
const STOP_AFTER_429 = 10;
// The stop is checked every 2 s, and a request in flight is already spent, so leave room.
const HARD_STOP = BUDGET - 15;

const tickets = loadDevTickets("/work/evals/golden.jsonl");
const sent = new Counter("sent");
const got429 = new Counter("got_429");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: Math.round(RATES[0] * 10),
      timeUnit: "10s", // so 0.2 RPS is expressible: 2 every ten seconds
      preAllocatedVUs: 30,
      maxVUs: 120,
      stages: STEPS.flatMap((s) => [
        { target: Math.round(s.rps * 10), duration: "1s" },
        { target: Math.round(s.rps * 10), duration: `${HOLD_S - 1}s` },
      ]),
    },
  },
  summaryTrendStats: ["min", "med", "p(95)", "p(99)", "max"],
  thresholds: {
    // `sent` is counted before the request goes out, so in-flight requests are included.
    sent: [{ threshold: `count<${HARD_STOP}`, abortOnFail: true, delayAbortEval: "0s" }],
    got_429: [{ threshold: `count<${STOP_AFTER_429}`, abortOnFail: true, delayAbortEval: "0s" }],
    ...stepThresholds(STEPS),
  },
};

function currentStep() {
  const t = (Date.now() - exec.scenario.startTime) / 1000;
  return (STEPS.find((s) => t < s.to) || STEPS[STEPS.length - 1]).name;
}

export default function () {
  sent.add(1);
  const { res } = triageOnce(URL, KEY, tickets, currentStep(), "30s");
  if (res.status === 429) got429.add(1);
}

export function setup() {
  console.log(
    [
      "",
      "Test 2: REAL model calls on staging.",
      `  Target:  ${URL}`,
      `  Plan:    ${RATES.join(" → ")} RPS, ${HOLD_S} s each = about ${PLANNED} requests.`,
      `  Budget:  hard stop at ${BUDGET} requests (the test aborts at ${HARD_STOP} sent, counting requests still in flight).`,
      `  Also stops after ${STOP_AFTER_429} responses with status 429.`,
      "  Each request is one Gemini call, up to 3 on retries, plus Cohere calls if it falls back.",
      "  The key's limit (60 a minute) answers some with 429 before any model is called: those cost nothing.",
      "",
    ].join("\n"),
  );
}

export function handleSummary(data) {
  const rows = stepRows(data, STEPS);
  const total = rows.reduce((a, r) => a + r.requests, 0);
  const sentTotal = data.metrics.sent ? data.metrics.sent.values.count : 0;
  const id = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const stoppedEarly = rows.some((r) => r.requests === 0);

  const lines = [
    `# Test 2: staging, real providers (${id})`,
    "",
    `**Real model calls.** ${sentTotal} requests sent (budget ${BUDGET}), ${total} answered, to ${URL}. One client key, dev tickets only.`,
    `${stoppedEarly ? "The test stopped before the last step (429s appeared or the budget was reached). " : ""}Trace sampling on staging should be 10% (TRACE_SAMPLE_RATE=0.1).`,
    "",
    "| Step (RPS) | n | p50 ms | p95 ms | p99 ms | errors by class | fallback rate |",
    "|---:|---:|---:|---:|---:|:--|---:|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.step.rps} | ${r.requests} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${errorsByClass(r.by, r.answered)} | ${pct(r.by.ok_fallback, r.answered)} |`);
  }
  const first429 = rows.find((r) => r.by.rate_limit > 0);
  lines.push(
    "",
    `- First 429 at: ${first429 ? `${first429.step.rps} RPS (n=${first429.requests} in that step)` : "none seen"}.`,
    `- 429 here means our per-client limit (class rate_limit) or the provider's, after the gateway's retries; the dashboard separates them (retries and fallbacks are on its own panels).`,
    `- Outcome classes counted: ${OUTCOMES.join(", ")}.`,
    "",
  );

  return {
    stdout: lines.join("\n") + "\n",
    [`/work/results/load/${id}-staging-real-ramp.md`]: lines.join("\n"),
    [`/work/results/load/${id}-staging-real-ramp.json`]: JSON.stringify({ test: "staging-real-ramp", mock: false, id, budget: BUDGET, sent: sentTotal, steps: rows, k6: data }, null, 2),
  };
}
