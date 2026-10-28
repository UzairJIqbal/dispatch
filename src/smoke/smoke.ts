// `pnpm smoke`: after a deploy, and from the synthetic probe. Waits until the
// service is ready on the expected commit, then sends a few real tickets.
// The pure parts live here so they can be tested without a server.
import { parseArgs } from "node:util";
import { z } from "zod";
import { TriageAnswerSchema } from "../triage/schema.js";

const USAGE = "Usage: pnpm smoke --url https://... [--sha <git sha>] [--count 3] [--wait 600]   (client key in SMOKE_KEY)";

export type SmokeArgs = {
  url: string;
  /** The commit that must be serving. Unset: any commit (the probe). */
  sha: string | undefined;
  /** Real tickets to send. 0 only waits for /readyz. */
  count: number;
  /** Seconds to wait for /readyz on the right commit. */
  waitS: number;
};

const ArgsSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/, "a git sha, e.g. from `git rev-parse --short HEAD`").optional(),
  // Each ticket is a real model call: kept small on purpose.
  count: z.coerce.number().int().min(0).max(5).default(3),
  // A Render free deploy pulls the image and cold-starts: a few minutes.
  wait: z.coerce.number().int().positive().max(1800).default(600),
});

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  let values: unknown;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { url: { type: "string" }, sha: { type: "string" }, count: { type: "string" }, wait: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, { cause: err });
  }
  const parsed = ArgsSchema.safeParse(values);
  if (!parsed.success) throw new Error(`${z.prettifyError(parsed.error)}\n${USAGE}`);
  const a = parsed.data;
  return { url: a.url.replace(/\/+$/, ""), sha: a.sha, count: a.count, waitS: a.wait };
}

export const ReadySchema = z.object({ status: z.string(), git_sha: z.string(), failing: z.array(z.string()).optional() });

/** Ready, and on the expected commit. Short and full shas match each other by prefix. */
export function readyOn(body: z.infer<typeof ReadySchema>, status: number, sha: string | undefined): boolean {
  if (status !== 200 || body.status !== "ready") return false;
  if (sha === undefined) return true;
  return body.git_sha.startsWith(sha) || sha.startsWith(body.git_sha);
}

// The whole answer is checked, closed like the service's own schema: a smoke
// test that only looked at the status code would pass a broken deploy.
export const SmokeAnswerSchema = TriageAnswerSchema.extend({
  meta: z.object({
    prompt_version: z.string(),
    model: z.string(),
    provider: z.string(),
    fallback: z.boolean(),
    git_sha: z.string(),
    request_id: z.string(),
    trace_id: z.string().optional(),
    latency_ms: z.number(),
  }),
});
export type SmokeAnswer = z.infer<typeof SmokeAnswerSchema>;

/** The checked answer, or why it fails the smoke test. */
export function checkAnswer(status: number, body: unknown, sha: string | undefined): { ok: true; answer: SmokeAnswer } | { ok: false; problem: string } {
  if (status !== 200) {
    const err = z.object({ error: z.object({ class: z.string() }) }).safeParse(body);
    return { ok: false, problem: `HTTP ${String(status)}${err.success ? ` ${err.data.error.class}` : ""}` };
  }
  const parsed = SmokeAnswerSchema.safeParse(body);
  if (!parsed.success) return { ok: false, problem: `answer has the wrong shape: ${z.prettifyError(parsed.error)}` };
  const got = parsed.data.meta.git_sha;
  if (sha !== undefined && !(got.startsWith(sha) || sha.startsWith(got))) return { ok: false, problem: `served by ${got}, expected ${sha}` };
  return { ok: true, answer: parsed.data };
}

/** `count` different tickets, picked at random so repeated runs cover the split. */
export function pick<T>(rows: readonly T[], count: number, random = Math.random): T[] {
  const pool = [...rows];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    const [row] = pool.splice(Math.floor(random() * pool.length), 1);
    if (row !== undefined) out.push(row);
  }
  return out;
}
