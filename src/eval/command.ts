// Shared by `pnpm eval` and `pnpm eval:noise`: load the split, say what the
// run will spend, run it, and turn a stop into a plain sentence.
import { loadModelsConfig, type ProviderName } from "../gateway/config.js";
import { gitSha } from "../env.js";
import { loadGolden } from "../golden/golden.js";
import type { GoldenRow, Split } from "../golden/schema.js";
import { ResponseCache } from "../triage/cache.js";
import { loadPrompt } from "../triage/prompt.js";
import { computeMetrics } from "./report.js";
import type { Metrics, RunInfo, TicketRecord } from "./results.js";
import { planEval, runEval, type EvalPlan } from "./run.js";
import { Gateway } from "../triage/triage.js";

export type RunRequest = {
  split: Split;
  version: string;
  provider?: ProviderName;
  refresh: boolean;
  gateway?: Gateway;
  /** Printed before the run starts, e.g. "run 1 of 2". */
  label?: string;
};

export type CompletedRun = { run: RunInfo; metrics: Metrics; records: TicketRecord[] };

export async function loadSplit(split: Split): Promise<{ datasetVersion: string; rows: GoldenRow[] }> {
  const { header, rows } = await loadGolden();
  return { datasetVersion: header.dataset_version, rows: rows.filter((r) => r.split === split) };
}

export function describePlan(plan: EvalPlan, refresh: boolean, label = ""): string {
  const { resolved } = plan;
  const rpm = loadModelsConfig().providers[resolved.provider].rpm;
  // Matches the pacer: calls are spaced 10% wider than the published limit.
  const minutes = rpm ? Math.ceil((plan.calls * 1.1) / rpm) : 0;
  const time = plan.calls === 0 ? "" : rpm ? ` Paced to ${String(rpm)} calls/min (${resolved.provider} free tier): about ${String(minutes)} min.` : "";
  return (
    `${label}${String(plan.total)} tickets on ${resolved.provider} ${resolved.model}: ` +
    `${String(plan.calls)} real model calls, ${String(plan.cached)} from cache${refresh ? " (--no-cache: cache not read)" : ""}.${time}`
  );
}

function progress(done: number, total: number): void {
  if (process.stderr.isTTY) process.stderr.write(`\r  ${String(done)}/${String(total)}`);
  if (process.stderr.isTTY && done === total) process.stderr.write("\n");
}

function stopMessage(err: { errorClass: string; message: string }, done: number, total: number, refresh: boolean): string {
  const resume = refresh
    ? "This was a --no-cache run, so rerunning starts it over: wait for the limit to reset first."
    : `The ${String(done)} answers so far are cached: run the same command again to pick up where it stopped.`;
  if (err.errorClass === "rate_limit") {
    return `Stopped after ${String(done)} of ${String(total)} tickets: the provider's rate limit was hit (${err.message}).\n${resume}`;
  }
  return `Stopped after ${String(done)} of ${String(total)} tickets: ${err.message}\nThis will fail on every ticket, so nothing more was sent. Check the key in .env and the model name in config/models.yaml.`;
}

export async function executeRun(req: RunRequest): Promise<CompletedRun> {
  const prompt = loadPrompt(req.version);
  const { datasetVersion, rows } = await loadSplit(req.split);
  const cache = new ResponseCache();
  try {
    const plan = planEval(rows, { version: req.version, ...(req.provider ? { provider: req.provider } : {}), cache, refresh: req.refresh });
    const gateway = req.gateway ?? new Gateway();
    // Fails on a missing key now, before the plan reads as if the run started.
    // A fully cached run needs no key.
    if (plan.calls > 0) gateway.provider(plan.resolved.provider);
    console.log(describePlan(plan, req.refresh, req.label ? `${req.label}: ` : ""));

    const startedAt = new Date();
    const outcome = await runEval(rows, {
      version: req.version,
      ...(req.provider ? { provider: req.provider } : {}),
      gateway,
      cache,
      refresh: req.refresh,
      onProgress: progress,
    });
    if (outcome.stoppedBy) {
      if (process.stderr.isTTY) process.stderr.write("\n");
      throw new Error(stopMessage(outcome.stoppedBy, outcome.records.length, rows.length, req.refresh));
    }

    const { resolved } = plan;
    const run: RunInfo = {
      id: `${startedAt.toISOString()}-${prompt.version}-${req.split}`,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      split: req.split,
      prompt_version: prompt.version,
      provider: resolved.provider,
      model: resolved.model,
      dataset_version: datasetVersion,
      git_sha: gitSha(),
      cache: req.refresh ? "skipped" : "used",
    };
    return { run, metrics: computeMetrics(outcome.records, resolved.price, resolved.priceDate), records: outcome.records };
  } finally {
    cache.close();
  }
}
