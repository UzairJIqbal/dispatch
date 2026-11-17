// Shared by both load tests. k6 runs this as plain JavaScript (not Node, not
// TypeScript), so it reads files with open() and takes settings from __ENV.
import http from "k6/http";
import { Counter } from "k6/metrics";

// Every way a request can end, by the names the service uses (error.class in
// its answers) plus the two only a client can see. One counter per step and
// outcome gives the table its "error rate by class" and "fallback rate".
export const OUTCOMES = [
  "ok",
  "ok_fallback",
  "rate_limit",
  "timeout",
  "provider_5xx",
  "schema_fail",
  "bad_request",
  "circuit_open",
  "unauthorized",
  "no_answer", // the client gave up (k6 timeout) or the connection failed
  "other",
];
const KNOWN_CLASSES = new Set(OUTCOMES);

export const outcomes = new Counter("outcomes");

/** Dev tickets only: the test split is for grading, never for load. */
export function loadDevTickets(path) {
  const lines = open(path).split("\n").filter((l) => l.trim() !== "");
  // First line is the dataset header, the rest are tickets.
  const rows = lines.slice(1).map((l) => JSON.parse(l));
  const dev = rows.filter((r) => r.split === "dev").map((r) => r.text);
  if (dev.length === 0) throw new Error(`No dev tickets in ${path}. \`pnpm golden:import\` fills the golden set.`);
  return dev;
}

export function firstKey(value, name) {
  const key = (value || "").split(",")[0].trim();
  if (!key.startsWith("dsp_")) throw new Error(`${name} must hold a client key (it starts with dsp_). Set it in .env: see .env.example.`);
  return key;
}

/** One ticket to POST /v1/triage; tags the outcome with the step it belongs to. */
export function triageOnce(url, key, tickets, step, timeout) {
  const text = tickets[Math.floor(Math.random() * tickets.length)];
  const res = http.post(`${url}/v1/triage`, JSON.stringify({ text }), {
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    timeout,
    // The step tag puts this request's latency and count in that step's row.
    tags: { step },
    // Non-2xx answers are expected under load; they are counted by class, not as k6 failures.
    responseCallback: http.expectedStatuses({ min: 200, max: 599 }),
  });
  const outcome = classify(res);
  outcomes.add(1, { step, outcome });
  return { res, outcome };
}

function classify(res) {
  if (res.status === 0) return "no_answer";
  let body;
  try {
    body = res.json();
  } catch {
    return "other";
  }
  if (res.status === 200) return body && body.meta && body.meta.fallback ? "ok_fallback" : "ok";
  const cls = body && body.error ? body.error.class : undefined;
  if (cls === "unauthorized") return "unauthorized";
  return KNOWN_CLASSES.has(cls) ? cls : "other";
}

/**
 * k6 only reports a tagged sub-metric in its summary if a threshold names it.
 * These never fail (max>=0 and count>=0 are always true); they only make the
 * per-step numbers appear.
 */
export function stepThresholds(steps) {
  const t = {};
  for (const s of steps) {
    t[`http_req_duration{step:${s.name}}`] = ["max>=0"];
    t[`http_reqs{step:${s.name}}`] = ["count>=0"];
    for (const o of OUTCOMES) t[`outcomes{step:${s.name},outcome:${o}}`] = ["count>=0"];
  }
  return t;
}

function counted(data, name) {
  const m = data.metrics[name];
  return m && m.values ? m.values.count : 0;
}

/** One row per step, read out of k6's end-of-test data. */
export function stepRows(data, steps) {
  return steps.map((s) => {
    const dur = data.metrics[`http_req_duration{step:${s.name}}`];
    const v = dur ? dur.values : {};
    const n = counted(data, `http_reqs{step:${s.name}}`);
    const by = {};
    for (const o of OUTCOMES) by[o] = counted(data, `outcomes{step:${s.name},outcome:${o}}`);
    const answered = OUTCOMES.reduce((sum, o) => sum + by[o], 0);
    return { step: s, requests: n, answered, p50: v.med, p95: v["p(95)"], p99: v["p(99)"], by };
  });
}

export function pct(k, n) {
  return n === 0 ? "-" : `${((100 * k) / n).toFixed(1)}%`;
}

export function ms(v) {
  return v === undefined ? "-" : String(Math.round(v));
}

/** "rate_limit 3 (2.0%), timeout 1 (0.7%)" or "none". */
export function errorsByClass(by, n) {
  const parts = OUTCOMES.filter((o) => o !== "ok" && o !== "ok_fallback" && by[o] > 0).map((o) => `${o} ${by[o]} (${pct(by[o], n)})`);
  return parts.length === 0 ? "none" : parts.join(", ");
}
