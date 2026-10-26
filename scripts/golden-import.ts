import { createHash } from "node:crypto";
import { paths, rel } from "../src/paths.js";
import { loadBitextCsv, parseBitextCsv } from "../src/golden/bitext.js";
import { readMessyTickets, serializeTickets, writeAtomic } from "../src/golden/files.js";
import { PER_CATEGORY, SAMPLE_SEED, sampleBitext } from "../src/golden/sample.js";
import { run } from "./run.js";

run(async () => {
  const rows = parseBitextCsv(await loadBitextCsv());
  const bitext = sampleBitext(rows);
  const messy = await readMessyTickets();
  const tickets = [...bitext, ...messy].sort((a, b) => a.id.localeCompare(b.id));

  const seen = new Set<string>();
  for (const t of tickets) {
    if (seen.has(t.id)) throw new Error(`Ticket id ${t.id} appears twice. Ids must be unique (check ${rel(paths.messy)}).`);
    seen.add(t.id);
  }

  const content = serializeTickets(tickets);
  await writeAtomic(paths.tickets, content);
  const sha = createHash("sha256").update(content).digest("hex").slice(0, 12);
  console.log(
    `Read ${String(rows.length)} Bitext rows. Sampled ${String(bitext.length)} (${String(PER_CATEGORY)} per category, seed ${String(SAMPLE_SEED)}) ` +
      `+ ${String(messy.length)} messy = ${String(tickets.length)} tickets.\n` +
      `Wrote ${rel(paths.tickets)} (sha256 ${sha}). Next: \`pnpm label\`.`,
  );
});
