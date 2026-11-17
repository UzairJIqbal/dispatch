// Test 1: the service itself, on the mock. Ramps 1 → 50 requests a second in
// held steps and shows where our own code starts to slow down. The mock's
// latency is sampled from the real latencies in results/baseline.json (MOCK_MODE=slow),
// so the provider's part is realistic and what changes with load is ours.
// No real model calls. The rate limit is off for this run (RATE_LIMIT=off, mock
// only), so the Redis round trip it costs is not in these numbers.
//
// Run:  docker compose --profile load run --rm --no-deps k6   (see compose.yaml)
import exec from "k6/execution";
import { loadDevTickets, firstKey, triageOnce, stepThresholds, stepRows, pct, ms, errorsByClass, OUTCOMES } from "./lib.js";

const URL = __ENV.TARGET_URL || "http://dispatch:3000";
const KEY = firstKey(__ENV.DISPATCH_TRAFFIC_KEYS, "DISPATCH_TRAFFIC_KEYS");
const SLO_P95_MS = 4000; // docs/SLOS.md
const HOLD_S = 60;
const RAMP_S = 1;
const RATES = [1, 2, 5, 10, 20, 30, 40, 50];
const STEPS = RATES.map((rps, i) => ({ name: `rps_${rps}`, rps, from: i * (HOLD_S + RAMP_S), to: (i + 1) * (HOLD_S + RAMP_S) }));

const tickets = loadDevTickets("/work/evals/golden.jsonl");
const baseline = JSON.parse(open("/work/results/baseline.json"));
const floor = (() => {
  const l = baseline.tickets.filter((t) => t.latency_ms !== null && !t.cached).map((t) => t.latency_ms).sort((a, b) => a - b);
  const q = (p) => l[Math.min(l.length - 1, Math.ceil(p * l.length) - 1)];
  return { n: l.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), run: baseline.run.id };
})();

export const options = {
  // Open model: requests arrive on the clock whether or not the last one has
  // answered, like real users. A slow service shows as latency, not fewer requests.
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: STEPS[0].rps,
      timeUnit: "1s",
      // Little's law: 50 RPS × a mean of a few seconds is a few hundred requests in flight.
      preAllocatedVUs: 200,
      maxVUs: 700,
      stages: STEPS.flatMap((s) => [
        { target: s.rps, duration: `${RAMP_S}s` },
        { target: s.rps, duration: `${HOLD_S}s` },
      ]),
    },
  },
  summaryTrendStats: ["min", "med", "p(95)", "p(99)", "max"],
  thresholds: {
    // Not a pass/fail on the SLO (the mock floor alone is over it, see the table):
    // this only fails the run if k6 itself could not generate the load.
    dropped_iterations: ["count<1"],
    ...stepThresholds(STEPS),
  },
};

function currentStep() {
  const t = (Date.now() - exec.scenario.startTime) / 1000;
  return (STEPS.find((s) => t < s.to) || STEPS[STEPS.length - 1]).name;
}

export default function () {
  triageOnce(URL, KEY, tickets, currentStep(), "30s");
}

export function setup() {
  console.log(`Test 1 (mock, no real calls): ${RATES.join(" → ")} RPS, ${HOLD_S} s each, about ${RATES.reduce((a, r) => a + r * HOLD_S, 0)} requests to ${URL}.`);
}

export function handleSummary(data) {
  const rows = stepRows(data, STEPS);
  const total = rows.reduce((a, r) => a + r.requests, 0);
  const dropped = data.metrics.dropped_iterations ? data.metrics.dropped_iterations.values.count : 0;
  const id = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");

  const lines = [
    `# Test 1: the service on the mock (${id})`,
    "",
    `**Mock, no real model calls.** ${total} requests over ${RATES.length} steps of ${HOLD_S} s, one client key, dev tickets only. Rate limit off (mock only), so the Redis round trip is not included.`,
    `Mock latency is sampled from the Phase 2 baseline (${floor.run}: ${floor.n} uncached real calls). Open model: requests arrive on the clock, so a slow service shows as latency, not fewer requests.`,
    "",
    `Baseline (the mock's own floor, n=${floor.n}, real Gemini): p50 ${floor.p50} ms, p95 ${floor.p95} ms, p99 ${floor.p99} ms. SLO: p95 under ${SLO_P95_MS} ms (docs/SLOS.md).`,
    "",
    "| Step (RPS) | n | p50 ms | p95 ms | p99 ms | over SLO? | errors by class | fallback rate |",
    "|---:|---:|---:|---:|---:|:--|:--|---:|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.step.rps} | ${r.requests} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${r.p95 > SLO_P95_MS ? "yes" : "no"} | ${errorsByClass(r.by, r.answered)} | ${pct(r.by.ok_fallback, r.answered)} |`,
    );
  }
  const overSlo = rows.find((r) => r.p95 > SLO_P95_MS);
  // Our own slowdown: the median moving off the sampled floor and staying there. The p95
  // can't show it because the floor's p95 (a few slow real calls) is already past the SLO.
  // "Staying there" because one step's median is noisy; a step needs 30 requests to count.
  const over = (r) => r.requests >= 30 && r.p50 > floor.p50 * 1.25;
  const slowed = rows.find((r, i) => rows.slice(i).every(over));
  const at5 = rows.find((r) => r.step.rps === 5);
  lines.push(
    "",
    `- At the SLO's own load (5 RPS): p95 ${at5 ? `${ms(at5.p95)} ms (n=${at5.requests})` : "not run"}, against the ${SLO_P95_MS} ms target.`,
    `- p95 first crossed the ${SLO_P95_MS} ms SLO at: ${overSlo ? `${overSlo.step.rps} RPS (p95 ${ms(overSlo.p95)} ms, n=${overSlo.requests})` : "no step"}. ` +
      `${overSlo && overSlo.step.rps === RATES[0] ? "That is the mock's own floor (the baseline p95 is already over the SLO), not our code. " : ""}`,
    `- Our code started to add latency (p50 more than 25% over the floor's ${floor.p50} ms, at this step and every later one) at: ${slowed ? `${slowed.step.rps} RPS (p50 ${ms(slowed.p50)} ms, n=${slowed.requests})` : "no step: p50 stayed within 25% of the floor up to " + RATES[RATES.length - 1] + " RPS"}.`,
    `- Dropped iterations (k6 could not start a request on time): ${dropped}.${dropped > 0 ? " The load generator was the limit, not the service: read the later steps with care." : ""}`,
    `- Outcome classes counted: ${OUTCOMES.join(", ")}.`,
    "",
  );

  return {
    stdout: lines.join("\n") + "\n",
    [`/work/results/load/${id}-mock-ramp.md`]: lines.join("\n"),
    [`/work/results/load/${id}-mock-ramp.json`]: JSON.stringify({ test: "mock-ramp", mock: true, id, steps: rows, floor, k6: data }, null, 2),
  };
}
