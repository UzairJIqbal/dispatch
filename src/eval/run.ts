import type { ProviderName, ResolvedModel } from "../gateway/config.js";
import { ProviderError } from "../gateway/errors.js";
import type { GoldenRow } from "../golden/schema.js";
import type { ResponseCache } from "../triage/cache.js";
import { prepareCall, triage, type Gateway } from "../triage/triage.js";
import { gradeTicket } from "./graders.js";
import type { TicketRecord } from "./results.js";

// "A few at a time": enough to overlap slow calls, few enough to be gentle.
// On a free tier the provider's pacer is the real limit anyway.
export const CONCURRENCY = 4;

export type EvalOptions = {
  version: string;
  provider?: ProviderName;
  cache: ResponseCache;
  /** --no-cache: don't read the cache (fresh answers are still stored). */
  refresh: boolean;
  gateway?: Gateway;
  onProgress?: (done: number, total: number) => void;
};

export type EvalPlan = { resolved: ResolvedModel; total: number; cached: number; calls: number };

/** What a run will cost before it starts: how many real calls it makes. */
export function planEval(rows: readonly GoldenRow[], opts: Pick<EvalOptions, "version" | "provider" | "cache" | "refresh">): EvalPlan {
  let cached = 0;
  let resolved: ResolvedModel | undefined;
  for (const row of rows) {
    const call = prepareCall(row.text, opts.version, opts.provider);
    resolved = call.resolved;
    if (!opts.refresh && opts.cache.get(call.key)) cached++;
  }
  if (!resolved) throw new Error("No tickets to run.");
  return { resolved, total: rows.length, cached, calls: rows.length - cached };
}

export type EvalOutcome = {
  records: TicketRecord[];
  /** Set when the run stopped early: a rate limit, or an error every other call would hit too. */
  stoppedBy?: ProviderError;
};

// A 429 means the free tier is used up for now; a bad key or an unknown model
// (401, 403, 404) will fail on every ticket. Either way, going on only burns
// quota. Any other 4xx can be about one ticket: Cohere answers some with a 422
// "No valid response generated". That is recorded as a failed ticket and the
// run goes on, unless it keeps happening, which means it is the request, not
// the ticket.
const FAILS_EVERY_TICKET = new Set([401, 403, 404]);
export const MAX_BAD_REQUESTS_IN_A_ROW = 3;

export function stopsTheRun(err: ProviderError, badRequestsInARow: number): boolean {
  if (err.errorClass === "rate_limit") return true;
  if (err.errorClass !== "bad_request") return false;
  return (err.status !== undefined && FAILS_EVERY_TICKET.has(err.status)) || badRequestsInARow >= MAX_BAD_REQUESTS_IN_A_ROW;
}

async function runOne(row: GoldenRow, opts: EvalOptions): Promise<{ record: TicketRecord; err?: ProviderError }> {
  const expected = { category: row.category, priority: row.priority };
  const base = { id: row.id, source: row.source, expected };
  try {
    const r = await triage(row.text, opts.version, {
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.gateway ? { gateway: opts.gateway } : {}),
      cache: opts.cache,
      refresh: opts.refresh,
    });
    const answer = r.ok ? r.answer : null;
    const record: TicketRecord = {
      ...base,
      answer,
      error: r.ok ? null : r.error,
      ...(r.ok ? {} : { raw: r.raw }),
      grade: gradeTicket(expected, row.text, answer),
      cached: r.cached,
      latency_ms: r.latency_ms,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
    };
    return { record };
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    const record: TicketRecord = {
      ...base,
      answer: null,
      error: { class: err.errorClass, message: err.message },
      grade: gradeTicket(expected, row.text, null),
      cached: false,
      latency_ms: null,
      tokens_in: 0,
      tokens_out: 0,
    };
    return { record, err };
  }
}

export async function runEval(rows: readonly GoldenRow[], opts: EvalOptions): Promise<EvalOutcome> {
  const records: (TicketRecord | undefined)[] = new Array<TicketRecord | undefined>(rows.length);
  let next = 0;
  let done = 0;
  let stoppedBy: ProviderError | undefined;
  let badRequestsInARow = 0;

  async function worker(): Promise<void> {
    while (!stoppedBy) {
      const i = next++;
      const row = rows[i];
      if (!row) return;
      const { record, err } = await runOne(row, opts);
      badRequestsInARow = err?.errorClass === "bad_request" ? badRequestsInARow + 1 : 0;
      if (err && stopsTheRun(err, badRequestsInARow)) {
        stoppedBy ??= err;
        return;
      }
      records[i] = record;
      opts.onProgress?.(++done, rows.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  // Keep the golden set's order, so two results files diff line by line.
  const ordered = records.filter((r): r is TicketRecord => r !== undefined);
  return stoppedBy ? { records: ordered, stoppedBy } : { records: ordered };
}
