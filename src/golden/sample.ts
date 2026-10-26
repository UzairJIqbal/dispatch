import { createHash } from "node:crypto";
import { CATEGORIES, type Category } from "../categories.js";
import type { Ticket } from "./schema.js";

export const SAMPLE_SEED = 1;
export const PER_CATEGORY = 22; // 11 categories × 22 = 242 tickets

export type BitextRow = { category: Category; text: string };

// Small seeded PRNG (mulberry32). Math.random can't be seeded, and the import
// has to give the same tickets every time it runs.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The id comes from the content, not the row position, so it survives the
// dataset being re-ordered and stays the same on every import.
export function bitextId(category: Category, text: string): string {
  return `bitext-${createHash("sha256").update(`${category}\n${text}`).digest("hex").slice(0, 10)}`;
}

/** Same number of tickets from every category, chosen by a seeded shuffle. */
export function sampleBitext(rows: readonly BitextRow[], seed = SAMPLE_SEED, perCategory = PER_CATEGORY): Ticket[] {
  const random = mulberry32(seed);
  const picked: Ticket[] = [];
  for (const category of CATEGORIES) {
    // Bitext repeats some texts; keep the first so two tickets never share an id.
    const texts = [...new Set(rows.filter((r) => r.category === category).map((r) => r.text))];
    if (texts.length < perCategory) {
      throw new Error(`Category "${category}" has only ${String(texts.length)} distinct tickets, need ${String(perCategory)}.`);
    }
    for (let i = texts.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [texts[i], texts[j]] = [texts[j] as string, texts[i] as string];
    }
    for (const text of texts.slice(0, perCategory)) {
      picked.push({ id: bitextId(category, text), source: "bitext", category, text });
    }
  }
  return picked;
}
