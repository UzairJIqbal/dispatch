// The eval gate.
//   pnpm gate --candidate <run.json> [--baseline results/baseline.json] [--rules config/gate.yaml]
//             [--noise results/noise.json] [--markdown gate.md] [--baseline-label ...] [--rules-label ...]
//   pnpm gate --check-baseline <run.json>   (may this main run become the baseline?)
// Prints the table, writes it as markdown for the PR comment, and exits 1 when a rule fails.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { baselineProblems, formatGate, loadGateRules, pickNoise, runGate } from "../src/eval/gate.js";
import { readNoiseFile, readResultsFile } from "../src/eval/results.js";
import { paths, rel } from "../src/paths.js";
import { run } from "./run.js";

const USAGE =
  "Usage: pnpm gate --candidate <run.json> [--baseline <file>] [--rules <file>] [--noise <file>] [--markdown <out.md>] [--baseline-label <text>] [--rules-label <text>]\n" +
  "       pnpm gate --check-baseline <run.json>";

const ArgsSchema = z.strictObject({
  candidate: z.string().min(1).optional(),
  baseline: z.string().min(1).default(paths.baseline),
  rules: z.string().min(1).default(paths.gateRules),
  noise: z.string().min(1).default(paths.noise),
  markdown: z.string().min(1).optional(),
  "baseline-label": z.string().min(1).optional(),
  "rules-label": z.string().min(1).optional(),
  "check-baseline": z.string().min(1).optional(),
});

function need(file: string, what: string, fix: string): void {
  if (!existsSync(file)) throw new Error(`${what} not found at ${rel(file)}. ${fix}`);
}

run(async () => {
  let values: unknown;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: Object.fromEntries(Object.keys(ArgsSchema.shape).map((k) => [k, { type: "string" as const }])),
      strict: true,
    }));
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, { cause: err });
  }
  const parsed = ArgsSchema.safeParse(values);
  if (!parsed.success) throw new Error(`${z.prettifyError(parsed.error)}\n${USAGE}`);
  const a = parsed.data;

  if (a["check-baseline"]) {
    const file = a["check-baseline"];
    need(file, "The main run", "Run `pnpm eval --split test --no-cache --out <file>` first.");
    const problems = baselineProblems(await readResultsFile(file));
    if (problems.length > 0) throw new Error(`This run can't be the baseline:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    console.log(`${rel(file)} can be the baseline.`);
    return;
  }

  if (!a.candidate) throw new Error(`--candidate is required.\n${USAGE}`);
  need(a.candidate, "The candidate run", "Run `pnpm eval --split test --out <file>` first.");
  need(a.baseline, "The baseline", "Run `pnpm eval --split test --no-cache --write-baseline` to make one.");
  need(a.rules, "The gate rules", "They live in config/gate.yaml.");

  const baseline = await readResultsFile(a.baseline);
  const candidate = await readResultsFile(a.candidate);
  const noise = pickNoise(baseline, [baseline.noise_floor, existsSync(a.noise) ? await readNoiseFile(a.noise) : undefined]);
  const report = runGate(baseline, candidate, loadGateRules(a.rules), noise);
  const markdown = formatGate(report, baseline, candidate, {
    baseline: a["baseline-label"] ?? rel(a.baseline),
    rules: a["rules-label"] ?? rel(a.rules),
  });

  console.log(markdown);
  if (a.markdown) await writeFile(a.markdown, markdown);
  if (!report.ok) process.exitCode = 1;
});
// acceptance check 4: second commit on the same PR
