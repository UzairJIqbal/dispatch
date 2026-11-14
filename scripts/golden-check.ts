// Usage: pnpm golden:check --base <main's golden.jsonl>
// CI passes main's copy (from `git show`); without --base, only the file itself is checked.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { checkGoldenChange } from "../src/golden/check.js";
import { paths, rel } from "../src/paths.js";
import { run } from "./run.js";

run(async () => {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { base: { type: "string" } }, strict: true });
  const base = values.base;
  if (base !== undefined && !existsSync(base)) throw new Error(`--base ${base} doesn't exist. Pass main's golden file, e.g. \`git show origin/main:evals/golden.jsonl > /tmp/base.jsonl\`.`);
  const problems = checkGoldenChange({
    base: base === undefined ? undefined : await readFile(base, "utf8"),
    head: await readFile(paths.golden, "utf8"),
    changelog: existsSync(paths.changelog) ? await readFile(paths.changelog, "utf8") : "",
    file: rel(paths.golden),
  });
  if (problems.length > 0) throw new Error(`The golden set check failed:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  console.log(`${rel(paths.golden)} is fine${base === undefined ? "" : " compared with main's"}.`);
});
