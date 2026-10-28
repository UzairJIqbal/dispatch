import { mkdir } from "node:fs/promises";
import { parseEvalArgs } from "../src/eval/args.js";
import { executeRun, loadSplit } from "../src/eval/command.js";
import { formatReport } from "../src/eval/report.js";
import { findComparison, readNoise, runFileName, writeJson, type Noise, type ResultsFile } from "../src/eval/results.js";
import { loadModelsConfig, resolveModel } from "../src/gateway/config.js";
import { paths, rel } from "../src/paths.js";
import { loadPrompt } from "../src/triage/prompt.js";
import { run } from "./run.js";

run(async () => {
  const args = parseEvalArgs(process.argv.slice(2));
  const resolved = resolveModel(loadModelsConfig(), loadPrompt(args.version).model, args.provider);
  const { datasetVersion } = await loadSplit(args.split);

  // The noise floor only counts if it was measured on exactly this setup.
  const noise = await readNoise();
  const matchingNoise: Noise | undefined =
    noise &&
    noise.prompt_version === args.version &&
    noise.provider === resolved.provider &&
    noise.model === resolved.model &&
    noise.dataset_version === datasetVersion
      ? noise
      : undefined;

  // Checked before any call, so a mistake costs nothing.
  if (args.writeBaseline) {
    if (args.split !== "test") throw new Error("The baseline is the test-split result. Use `--split test --no-cache --write-baseline`.");
    if (!args.noCache) throw new Error("A baseline needs real latency, so every call must be uncached. Add `--no-cache`.");
    if (!matchingNoise) {
      throw new Error(
        `No noise floor for ${args.version} on ${resolved.provider} ${resolved.model}, golden ${datasetVersion}` +
          (noise ? ` (${rel(paths.noise)} is for ${noise.prompt_version} on ${noise.provider} ${noise.model}, golden ${noise.dataset_version})` : "") +
          `. Run \`pnpm eval:noise --version ${args.version}${args.provider ? ` --provider ${args.provider}` : ""}\` first; the baseline records it.`,
      );
    }
  }

  const done = await executeRun({ split: args.split, version: args.version, ...(args.provider ? { provider: args.provider } : {}), refresh: args.noCache });
  const file: ResultsFile = { run: done.run, metrics: done.metrics, tickets: done.records };

  console.log("");
  console.log(formatReport(done.run, done.metrics, await findComparison(done.run), matchingNoise));

  await mkdir(paths.results, { recursive: true });
  const out = runFileName(done.run);
  await writeJson(out, file);
  console.log(`\nWrote ${rel(out)}.`);

  // A failed call is graded wrong, so a baseline with failures mixes the
  // model's quality with the provider's bad minute. An answer from the
  // fallback is another model's: it doesn't belong in this model's baseline.
  const fallbacks = done.metrics.gateway?.fallbacks ?? 0;
  if (args.writeBaseline && fallbacks > 0) {
    throw new Error(
      `${String(fallbacks)} of ${String(done.metrics.n)} tickets were answered by the fallback, so ${rel(paths.baseline)} was not written: a baseline is one model's number.\n` +
        `The run itself is saved above. Try again when ${done.run.provider} is answering.`,
    );
  }
  if (args.writeBaseline && done.metrics.calls.failed > 0) {
    throw new Error(
      `${String(done.metrics.calls.failed)} of ${String(done.metrics.n)} calls failed (${Object.entries(done.metrics.errors)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(", ")}), so ${rel(paths.baseline)} was not written: a baseline is the model's number, not the provider's bad minute.\n` +
        `The run itself is saved above. Try again later, when the provider is calmer.`,
    );
  }
  if (args.writeBaseline && matchingNoise) {
    await writeJson(paths.baseline, { ...file, noise_floor: matchingNoise });
    console.log(`Wrote ${rel(paths.baseline)}: ${done.run.prompt_version} on golden ${datasetVersion}, noise floor ${String(matchingNoise.flips)} of ${String(matchingNoise.n)}.`);
  }
});
