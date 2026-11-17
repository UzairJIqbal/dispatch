import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { costModel, formatCost, inputSplit, type ModelPrice } from "../src/cost/cost.js";
import { loadGolden } from "../src/golden/golden.js";
import { readBaseline, readResultsFile, type ResultsFile } from "../src/eval/results.js";
import { loadModelsConfig, resolveChain } from "../src/gateway/config.js";
import { paths, rel } from "../src/paths.js";
import { loadPrompt } from "../src/triage/prompt.js";
import { run } from "./run.js";

// `pnpm cost [--file results/<run>.json]`: what the run's tokens would cost at
// list price. Default is the baseline, the run everything is compared against.
// With --file, the baseline is shown next to it (the before/after of an experiment).
run(async () => {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { file: { type: "string" } } });
  const baseline = await readBaseline();
  if (!values.file && !baseline) {
    throw new Error(`No results to price: ${rel(paths.baseline)} doesn't exist. \`pnpm eval --split test --write-baseline\` makes it (about 74 real Gemini calls).`);
  }
  if (values.file && !existsSync(values.file)) throw new Error(`${values.file} doesn't exist. \`pnpm eval --split dev\` writes results/<run>.json.`);
  const file: ResultsFile = values.file ? await readResultsFile(values.file) : (baseline as ResultsFile);

  // The chain comes from the run's own prompt: its alias, its primary and its fallback.
  const config = loadModelsConfig();
  const chain: ModelPrice[] = resolveChain(config, loadPrompt(file.run.prompt_version).model, file.run.provider).map((m) => ({ provider: m.provider, model: m.model, price: m.price }));
  const models = costModel(file.tickets, chain);

  const { rows } = await loadGolden();
  const chars = new Map(rows.map((r) => [r.id, r.text.length]));
  const known = file.tickets.flatMap((t) => (chars.has(t.id) ? [chars.get(t.id) ?? 0] : []));
  const first = models[0];
  const split = first && known.length > 0 ? inputSplit(first.avgIn, known.reduce((a, b) => a + b, 0) / known.length) : undefined;

  const against = values.file && baseline && baseline.run.id !== file.run.id ? { label: `the baseline (${baseline.run.prompt_version}, ${baseline.run.split}, n=${String(baseline.tickets.length)})`, models: costModel(baseline.tickets, chain) } : undefined;
  console.log(
    formatCost({
      runLabel: `${file.run.id} (${file.run.prompt_version} on ${file.run.provider}, ${file.run.split} split, n=${String(file.tickets.length)}, git ${file.run.git_sha})`,
      priceDate: config.prices.date,
      models,
      ...(split ? { split } : {}),
      ...(against ? { against } : {}),
    }),
  );
});
