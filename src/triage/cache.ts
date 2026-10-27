import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { paths } from "../paths.js";
import type { ChatResponse } from "../gateway/providers.js";

// The response cache for evals: re-running the same eval is free, and a change
// to provider, model, prompt or parameters misses. The service never uses it.

export type CacheKeyParts = {
  provider: string;
  model: string;
  promptVersion: string;
  /** Hash of the prompt file: an edit to an unreleased file must miss too. */
  promptSha256: string;
  temperature: number;
  maxTokens: number;
  params: Readonly<Record<string, unknown>>;
  text: string;
};

export function cacheKey(parts: CacheKeyParts): string {
  // Fixed key order, so the same parts always hash the same.
  const p = parts;
  const canonical = JSON.stringify([p.provider, p.model, p.promptVersion, p.promptSha256, p.temperature, p.maxTokens, Object.entries(p.params).sort(), p.text]);
  return createHash("sha256").update(canonical).digest("hex");
}

const RowSchema = z.object({
  content: z.string(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  latency_ms: z.number().int().nonnegative(),
});

export class ResponseCache {
  private readonly db: DatabaseSync;

  constructor(file = paths.responseCache) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS responses (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tokens_in INTEGER NOT NULL,
      tokens_out INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  get(key: string): ChatResponse | undefined {
    const row = this.db.prepare("SELECT content, tokens_in, tokens_out, latency_ms FROM responses WHERE key = ?").get(key);
    if (row === undefined) return undefined;
    const parsed = RowSchema.safeParse(row);
    // A row we can't read is treated as a miss and overwritten on the next call.
    if (!parsed.success) return undefined;
    const r = parsed.data;
    return { content: r.content, tokensIn: r.tokens_in, tokensOut: r.tokens_out, latencyMs: r.latency_ms };
  }

  set(key: string, res: ChatResponse): void {
    this.db
      .prepare("INSERT OR REPLACE INTO responses (key, content, tokens_in, tokens_out, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, res.content, res.tokensIn, res.tokensOut, res.latencyMs, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
