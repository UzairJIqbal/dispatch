import { CATEGORIES } from "../categories.js";
import { PRIORITIES, SPLITS, type GoldenRow } from "./schema.js";

type Counts = Record<string, { dev: number; test: number }>;

function countBy(rows: readonly GoldenRow[], keys: readonly string[], key: (r: GoldenRow) => string): Counts {
  const counts: Counts = Object.fromEntries(keys.map((k) => [k, { dev: 0, test: 0 }]));
  for (const r of rows) {
    const c = counts[key(r)];
    if (c) c[r.split]++;
  }
  return counts;
}

export function goldenStats(rows: readonly GoldenRow[]) {
  const byCategory = countBy(rows, CATEGORIES, (r) => r.category);
  const byPriority = countBy(rows, PRIORITIES, (r) => r.priority);
  const bySource = countBy(rows, ["bitext", "messy"], (r) => r.source);
  const bySplit = Object.fromEntries(SPLITS.map((s) => [s, rows.filter((r) => r.split === s).length]));
  // What the set must have for a per-split number to mean anything.
  const gaps: string[] = [];
  for (const [name, counts] of [...Object.entries(byCategory), ...Object.entries(byPriority)]) {
    for (const split of SPLITS) if (counts[split] === 0) gaps.push(`${name} has no ${split} tickets`);
  }
  return { total: rows.length, bySplit, byCategory, byPriority, bySource, gaps };
}

function table(title: string, counts: Counts): string {
  const width = Math.max(title.length, ...Object.keys(counts).map((k) => k.length));
  const lines = [`${title.padEnd(width)}    dev   test  total`];
  for (const [k, c] of Object.entries(counts)) {
    lines.push(`${k.padEnd(width)}  ${String(c.dev).padStart(5)}  ${String(c.test).padStart(5)}  ${String(c.dev + c.test).padStart(5)}`);
  }
  return lines.join("\n");
}

export function formatStats(version: string, stats: ReturnType<typeof goldenStats>): string {
  const pct = (n: number) => `${((100 * n) / stats.total).toFixed(1)}%`;
  const dev = stats.bySplit.dev ?? 0;
  const test = stats.bySplit.test ?? 0;
  return [
    `Golden set ${version}: ${String(stats.total)} tickets`,
    `Split: dev ${String(dev)} (${pct(dev)}), test ${String(test)} (${pct(test)}). Target 75/25.`,
    "",
    table("category", stats.byCategory),
    "",
    table("priority", stats.byPriority),
    "",
    table("source", stats.bySource),
    "",
    stats.gaps.length === 0
      ? "Every category and every priority is in both splits."
      : `Gaps:\n${stats.gaps.map((g) => `  - ${g}`).join("\n")}`,
  ].join("\n");
}
