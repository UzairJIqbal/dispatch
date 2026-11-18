import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { paths, rel } from "../paths.js";
import { LabelsFileSchema, MessyTicketSchema, TicketSchema, type Labels, type Ticket } from "./schema.js";

/** Write to a temp file and rename, so a crash never leaves half a file. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await writeFile(`${path}.tmp`, content);
  await rename(`${path}.tmp`, path);
}

/** Parses JSONL, validating each line; errors name the file and line number. */
export function parseJsonl<T>(content: string, schema: z.ZodType<T>, file: string, firstLine = 1): T[] {
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  return lines.map((line, i) => {
    const lineNo = String(i + firstLine);
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${file} line ${lineNo} is not valid JSON.`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`${file} line ${lineNo} is invalid:\n${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
}

/** The hand-written tickets of one source. Each id must carry its source's prefix. */
async function readHandWritten(file: string, source: "messy" | "injection"): Promise<Ticket[]> {
  const parsed = z.array(MessyTicketSchema).safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new Error(`${rel(file)} is invalid:\n${z.prettifyError(parsed.error)}`);
  const wrong = parsed.data.find((t) => !t.id.startsWith(`${source}-`));
  if (wrong) throw new Error(`${rel(file)}: ${wrong.id} should start with ${source}-.`);
  return parsed.data.map((t) => ({ ...t, source }));
}

export function readMessyTickets(): Promise<Ticket[]> {
  return readHandWritten(paths.messy, "messy");
}

export function readInjectionTickets(): Promise<Ticket[]> {
  return readHandWritten(paths.injection, "injection");
}

export function serializeTickets(tickets: readonly Ticket[]): string {
  return tickets.map((t) => JSON.stringify({ id: t.id, source: t.source, category: t.category, text: t.text })).join("\n") + "\n";
}

export async function readTickets(): Promise<Ticket[]> {
  if (!existsSync(paths.tickets)) {
    throw new Error(`${rel(paths.tickets)} doesn't exist yet. Run \`pnpm golden:import\` to create it.`);
  }
  return parseJsonl(await readFile(paths.tickets, "utf8"), TicketSchema, rel(paths.tickets));
}

export async function readLabels(): Promise<Labels> {
  if (!existsSync(paths.labels)) return {};
  const parsed = LabelsFileSchema.safeParse(JSON.parse(await readFile(paths.labels, "utf8")));
  if (!parsed.success) throw new Error(`${rel(paths.labels)} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function writeLabels(labels: Labels): Promise<void> {
  // Sorted keys keep the file's diff small and stable.
  const sorted = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  await writeAtomic(paths.labels, JSON.stringify(sorted, null, 2) + "\n");
}
