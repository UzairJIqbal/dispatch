import { mkdir } from "node:fs/promises";
import { gitSha } from "../src/env.js";
import { parseNoiseArgs } from "../src/eval/args.js";
import { executeRun } from "../src/eval/command.js";
import { compareRuns } from "../src/eval/noise.js";
import { writeJson, type Noise } from "../src/eval/results.js";
import { paths, rel } from "../src/paths.js";
import { Gateway } from "../src/gateway/gateway.js";
import { run } from "./run.js";

// The test split twice, uncached, same everything. Only the flip count is
// looked at: the test split is graded, never read.
run(async () => {
  const args = parseNoiseArgs(process.argv.slice(2));
  const provider = args.provider ? { provider: args.provider } : {};
  // One gateway for both runs, so the free-tier pacing carries over between them.
  const gateway = new Gateway();

  const first = await executeRun({ split: "test", version: args.version, ...provider, refresh: true, gateway, label: "Run 1 of 2" });
  const second = await executeRun({ split: "test", version: args.version, ...provider, refresh: true, gateway, label: "Run 2 of 2" });
  const diff = compareRuns(first.records, second.records);

  const noise: Noise = {
    prompt_version: first.run.prompt_version,
    provider: first.run.provider,
    model: first.run.model,
    dataset_version: first.run.dataset_version,
    split: "test",
    measured_at: new Date().toISOString(),
    git_sha: gitSha(),
    n: first.metrics.n,
    ...diff,
    both_correct: [first.metrics.both, second.metrics.both],
  };
  await mkdir(paths.results, { recursive: true });
  await writeJson(paths.noise, noise);

  const pct = (k: number) => (noise.compared ? (100 * k) / noise.compared : 0).toFixed(1);
  const failed = noise.failed_ids.length;
  console.log(
    `\nNoise floor (${noise.prompt_version}, ${noise.provider} ${noise.model}, temperature 0, ` +
      `n = ${String(noise.compared)} of ${String(noise.n)} test tickets answered in both runs):\n` +
      `  ${String(noise.flips)} tickets flipped their label between two identical runs (${pct(noise.flips)}%).\n` +
      `  ${String(noise.both_flips)} changed their both-correct verdict (${pct(noise.both_flips)} pts of accuracy can move by chance).\n` +
      (failed
        ? `  ${String(failed)} failed in at least one run (timeout, 5xx or broken JSON) and are left out: that's the provider, not the model.\n`
        : "") +
      `  both correct: run 1 ${noise.both_correct[0].pct.toFixed(1)}%, run 2 ${noise.both_correct[1].pct.toFixed(1)}%.\n` +
      `Wrote ${rel(paths.noise)}. Next: \`pnpm eval --split test --no-cache --write-baseline\`.`,
  );
});
