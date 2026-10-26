import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { CategorySchema } from "../categories.js";
import { paths } from "../paths.js";
import { MAX_TICKET_CHARS } from "./schema.js";
import type { BitextRow } from "./sample.js";

// Pinned to one commit of the dataset and checked by hash, so the import keeps
// giving the same tickets even if Bitext publishes a new version.
const REPO = "bitext/Bitext-customer-support-llm-chatbot-training-dataset";
const REVISION = "430d1a89bd93bd1fa23c16f29dd53e73f0087443";
const FILE = "Bitext_Sample_Customer_Support_Training_Dataset_27K_responses-v11.csv";
const FILE_SHA256 = "6f81102b0100b97b8468eb04368033a23206bf1fde9d53500d5806ec1001a434";
export const BITEXT_URL = `https://huggingface.co/datasets/${REPO}/resolve/${REVISION}/${FILE}`;

/** Downloads the CSV once into .cache/ and checks it is the pinned file. */
export async function loadBitextCsv(): Promise<string> {
  const cached = `${paths.cache}/bitext-${REVISION.slice(0, 12)}.csv`;
  if (!existsSync(cached)) {
    console.log(`Downloading the Bitext dataset (~19 MB) from Hugging Face...`);
    let res: Response;
    try {
      res = await fetch(BITEXT_URL);
    } catch (err) {
      throw new Error(`Could not reach Hugging Face (${String(err)}). Check your connection and run again.`, { cause: err });
    }
    if (!res.ok) throw new Error(`Hugging Face answered ${String(res.status)} for ${BITEXT_URL}`);
    const body = Buffer.from(await res.arrayBuffer());
    await mkdir(paths.cache, { recursive: true });
    await writeFile(`${cached}.tmp`, body);
    await rename(`${cached}.tmp`, cached);
  }
  const body = await readFile(cached);
  const sha = createHash("sha256").update(body).digest("hex");
  if (sha !== FILE_SHA256) {
    throw new Error(`${cached} is not the pinned Bitext file (sha256 ${sha}). Delete it and run again.`);
  }
  return body.toString("utf8");
}

const CsvRecordSchema = z.object({
  instruction: z.string().trim().min(1).max(MAX_TICKET_CHARS),
  category: z
    .string()
    .transform((c) => c.toLowerCase())
    .pipe(CategorySchema),
});

/** Parses and validates every row. A bad row stops the import with its row number. */
export function parseBitextCsv(csv: string): BitextRow[] {
  const records = parse(csv, { columns: true, skip_empty_lines: true });
  return records.map((raw, i) => {
    const parsed = CsvRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Bitext data row ${String(i + 1)} is invalid (categories live in src/categories.ts):\n${z.prettifyError(parsed.error)}`,
      );
    }
    return { category: parsed.data.category, text: parsed.data.instruction };
  });
}
