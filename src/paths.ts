import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The nearest folder with a package.json: the repo when run with tsx from
// src/, and /app in the Docker image, where this file runs from dist/src/.
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("Can't find the project root (no package.json above src/paths).");
    dir = up;
  }
  return dir + sep;
}

const root = findRoot();

export const paths = {
  root,
  cache: `${root}.cache`,
  labellingGuide: `${root}evals/LABELLING.md`,
  changelog: `${root}evals/CHANGELOG.md`,
  messy: `${root}evals/messy-tickets.json`,
  tickets: `${root}evals/tickets.jsonl`,
  labels: `${root}evals/labels.json`,
  golden: `${root}evals/golden.jsonl`,
  models: `${root}config/models.yaml`,
  release: `${root}config/release.yaml`,
  prompts: `${root}prompts/triage`,
  repairPrompt: `${root}prompts/repair.yaml`,
  results: `${root}results`,
  baseline: `${root}results/baseline.json`,
  noise: `${root}results/noise.json`,
  responseCache: `${root}.cache/responses.sqlite`,
  env: `${root}.env`,
};

/** Path relative to the repo root, for messages. */
export function rel(path: string): string {
  return path.startsWith(root) ? path.slice(root.length) : path;
}
