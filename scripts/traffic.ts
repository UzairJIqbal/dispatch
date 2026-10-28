import { loadEnv } from "../src/env.js";
import { loadSplit } from "../src/eval/command.js";
import { Tally, TrafficAnswerSchema, TrafficErrorSchema, parseTrafficArgs, parseTrafficKeys } from "../src/traffic/traffic.js";
import { run } from "./run.js";

// `pnpm traffic [--rate 1] [--duration 300] [--url ...] [--real]`: dev-split
// tickets at a steady rate, so every dashboard panel has data. Test tickets are
// never sent: the test split is only for grading.

// Longer than the gateway's own 20 s budget, so the service always answers first.
const REQUEST_TIMEOUT_MS = 30_000;

run(async () => {
  loadEnv();
  const args = parseTrafficArgs(process.argv.slice(2), process.env);
  const keys = parseTrafficKeys(process.env.DISPATCH_TRAFFIC_KEYS, args.rate);
  const { rows } = await loadSplit("dev");
  if (rows.length === 0) throw new Error("The dev split is empty. `pnpm golden:import` fills the golden set.");

  // Which providers the service calls, from its own circuit gauge, before
  // anything is sent: the mock unless --real says a real model is fine.
  const password = process.env.METRICS_PASSWORD;
  const auth = password ? { authorization: `Basic ${Buffer.from(`metrics:${password}`).toString("base64")}` } : undefined;
  const scrape = await fetch(`${args.url}/metrics`, { ...(auth ? { headers: auth } : {}) }).catch((err: unknown) => {
    throw new Error(`Can't reach ${args.url} (${err instanceof Error ? err.message : String(err)}). Start it with \`docker compose up\` or \`pnpm dev\`.`);
  });
  if (scrape.status === 401) throw new Error(`${args.url}/metrics wants a password: set METRICS_PASSWORD in .env to the service's.`);
  if (!scrape.ok) throw new Error(`${args.url}/metrics answered ${String(scrape.status)}.`);
  const providers = [...(await scrape.text()).matchAll(/^dispatch_circuit_state\{provider="([a-z_]+)"\}/gm)].map((m) => m[1] ?? "");
  const real = providers.filter((p) => !p.startsWith("mock"));
  if (real.length > 0 && !args.real) {
    throw new Error(`The service at ${args.url} calls ${real.join(" and ")}: every request here would be a real model call. Pass --real if that's what you want.`);
  }

  const minutes = args.duration === undefined ? "until Ctrl-C" : `for ${String(Math.round(args.duration / 6) / 10)} min`;
  console.log(`${String(args.rate)} RPS to ${args.url} on ${providers.join(" → ") || "unknown providers"}, ${minutes}. ${String(rows.length)} dev tickets, ${String(keys.length)} keys.`);

  const tally = new Tally();
  let sent = 0;
  let inFlight = 0;
  let skipped = 0;
  // Open loop: a request goes out on the clock whether or not the last one
  // answered, as real users do. A slow service shows as latency, not as fewer
  // requests. The cap only stops a dead service piling up sockets.
  const maxInFlight = Math.ceil(args.rate * (REQUEST_TIMEOUT_MS / 1000));

  async function send(): Promise<void> {
    const row = rows[Math.floor(Math.random() * rows.length)];
    const key = keys[sent % keys.length];
    if (!row || !key) return;
    sent++;
    inFlight++;
    try {
      const res = await fetch(`${args.url}/v1/triage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ text: row.text }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await res.json().catch(() => undefined);
      if (res.ok) {
        const ok = TrafficAnswerSchema.safeParse(body);
        tally.add(ok.success ? (ok.data.meta.fallback ? "200 fallback" : "200") : "200 unreadable");
      } else {
        const err = TrafficErrorSchema.safeParse(body);
        tally.add(`${String(res.status)} ${err.success ? err.data.error.class : "?"}`);
      }
    } catch (err) {
      // The drills restart the service; a few of these while it comes back are expected.
      tally.add(err instanceof Error && err.name === "TimeoutError" ? "no answer in 30 s" : "unreachable");
    } finally {
      inFlight--;
    }
  }

  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (inFlight >= maxInFlight) skipped++;
      else void send();
    }, 1000 / args.rate);
    const report = setInterval(() => {
      console.log(`${new Date().toLocaleTimeString()}  ${tally.toString()}${skipped ? `  skipped (too many waiting): ${String(skipped)}` : ""}`);
    }, 10_000);
    const stop = () => {
      clearInterval(tick);
      clearInterval(report);
      resolve();
    };
    process.once("SIGINT", stop);
    if (args.duration !== undefined) setTimeout(stop, args.duration * 1000);
  });

  // Requests already sent get their answer, so the summary counts them.
  while (inFlight > 0) await new Promise((r) => setTimeout(r, 100));
  console.log(`\nDone. ${tally.toString()}${skipped ? `  skipped: ${String(skipped)}` : ""}`);
});
