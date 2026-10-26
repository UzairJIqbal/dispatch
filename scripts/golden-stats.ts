import { existsSync } from "node:fs";
import { paths } from "../src/paths.js";
import { readLabels, readTickets } from "../src/golden/files.js";
import { loadGolden } from "../src/golden/golden.js";
import { formatStats, goldenStats } from "../src/golden/stats.js";
import { run } from "./run.js";

run(async () => {
  if (!existsSync(paths.golden)) {
    const tickets = await readTickets();
    const labels = await readLabels();
    const done = tickets.filter((t) => t.id in labels).length;
    throw new Error(
      `No golden set yet: ${String(done)} of ${String(tickets.length)} tickets labelled. ` +
        "Run `pnpm label` to finish; it writes evals/golden.jsonl at the end.",
    );
  }
  const { header, rows } = await loadGolden();
  console.log(formatStats(header.dataset_version, goldenStats(rows)));
});
