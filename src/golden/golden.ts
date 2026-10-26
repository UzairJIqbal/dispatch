import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { paths, rel } from "../paths.js";
import { parseJsonl, readLabels, readTickets, writeAtomic } from "./files.js";
import { GoldenHeaderSchema, GoldenRowSchema, type GoldenHeader, type GoldenRow, type Labels, type Ticket } from "./schema.js";
import { splitFor } from "./split.js";

// Bump this, and add a line to evals/CHANGELOG.md, whenever the set changes.
export const GOLDEN_VERSION = "v1";

export function buildGoldenRows(tickets: readonly Ticket[], labels: Labels): GoldenRow[] {
  const missing = tickets.filter((t) => !(t.id in labels));
  if (missing.length > 0) {
    throw new Error(`${String(missing.length)} tickets have no priority yet. Run \`pnpm label\` to finish.`);
  }
  return tickets.map((t) => {
    const label = labels[t.id];
    if (!label) throw new Error(`unreachable: ${t.id} has no label`);
    return {
      id: t.id,
      source: t.source,
      split: splitFor(t.id),
      category: t.category,
      priority: label.priority,
      ...(label.note ? { note: label.note } : {}),
      text: t.text,
    };
  });
}

function hashLines(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// The first line is a header with the version and a hash of every row line
// after it. Any edit to a row changes the hash, so a hand edit can't slip in
// under the old version.
export function serializeGolden(version: string, rows: readonly GoldenRow[]): string {
  const lines = rows.map((r) => JSON.stringify(GoldenRowSchema.parse(r)));
  const header: GoldenHeader = { dataset_version: version, sha256: hashLines(lines), rows: lines.length };
  return [JSON.stringify(header), ...lines].join("\n") + "\n";
}

export function parseGolden(content: string, file = rel(paths.golden)): { header: GoldenHeader; rows: GoldenRow[] } {
  const [headerLine = "", ...rest] = content.split("\n");
  const lines = rest.filter((l) => l.trim() !== "");
  let headerJson: unknown;
  try {
    headerJson = JSON.parse(headerLine);
  } catch {
    throw new Error(`${file} line 1 should be the header with dataset_version and sha256.`);
  }
  const header = GoldenHeaderSchema.safeParse(headerJson);
  if (!header.success) throw new Error(`${file} header is invalid:\n${z.prettifyError(header.error)}`);
  const { dataset_version: version, sha256 } = header.data;
  const actual = hashLines(lines);
  if (actual !== sha256 || lines.length !== header.data.rows) {
    throw new Error(
      `${file} changed but still says ${version}: its rows no longer match the hash in its header.\n` +
        `Undo the edit (git checkout ${file}), or make the change properly: bump GOLDEN_VERSION, ` +
        `add a line to evals/CHANGELOG.md saying why, and rebuild with \`pnpm label\`.`,
    );
  }
  return { header: header.data, rows: parseJsonl(lines.join("\n"), GoldenRowSchema, file, 2) };
}

export async function loadGolden(): Promise<{ header: GoldenHeader; rows: GoldenRow[] }> {
  if (!existsSync(paths.golden)) {
    throw new Error(`${rel(paths.golden)} doesn't exist yet. Finish labelling with \`pnpm label\`; it writes the file at the end.`);
  }
  return parseGolden(await readFile(paths.golden, "utf8"));
}

/** Builds evals/golden.jsonl from the tickets and labels. Refuses to change it without a version bump. */
export async function writeGolden(): Promise<{ header: GoldenHeader; written: boolean }> {
  const content = serializeGolden(GOLDEN_VERSION, buildGoldenRows(await readTickets(), await readLabels()));
  const { header } = parseGolden(content);

  const changelog = existsSync(paths.changelog) ? await readFile(paths.changelog, "utf8") : "";
  if (!new RegExp(`\\*\\*${GOLDEN_VERSION}\\*\\*`).test(changelog)) {
    throw new Error(`${rel(paths.changelog)} has no line for ${GOLDEN_VERSION}. Add one saying what changed and why.`);
  }

  if (existsSync(paths.golden)) {
    const existing = await readFile(paths.golden, "utf8");
    if (existing === content) return { header, written: false };
    const old = parseGolden(existing);
    if (old.header.dataset_version === GOLDEN_VERSION) {
      throw new Error(
        `${rel(paths.golden)} is already ${GOLDEN_VERSION} and this would change it.\n` +
          `Bump GOLDEN_VERSION in src/golden/golden.ts and add a line to ${rel(paths.changelog)}. ` +
          `(If ${GOLDEN_VERSION} was never committed, delete ${rel(paths.golden)} and run again.)`,
      );
    }
  }
  await writeAtomic(paths.golden, content);
  return { header, written: true };
}
