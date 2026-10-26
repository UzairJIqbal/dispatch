import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const paths = {
  root,
  cache: `${root}.cache`,
  labellingGuide: `${root}evals/LABELLING.md`,
  changelog: `${root}evals/CHANGELOG.md`,
  messy: `${root}evals/messy-tickets.json`,
  tickets: `${root}evals/tickets.jsonl`,
  labels: `${root}evals/labels.json`,
  golden: `${root}evals/golden.jsonl`,
};

/** Path relative to the repo root, for messages. */
export function rel(path: string): string {
  return path.startsWith(root) ? path.slice(root.length) : path;
}
