import { context } from "@opentelemetry/api";
import { cacheKey, type ResponseCache } from "../gateway/cache.js";
import { loadModelsConfig, resolveChain, type ProviderName, type ResolvedModel } from "../gateway/config.js";
import { ProviderError } from "../gateway/errors.js";
import type { Gateway } from "../gateway/gateway.js";
import { gitSha } from "../env.js";
import { failSpan, labelsOut, startRoot, traceId } from "../tracing/tracing.js";
import type { GoldenRow } from "../golden/schema.js";
import { firstTryKeyParts, triage } from "../triage/triage.js";
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
  /** The run's id: every ticket's trace goes under this Langfuse session. */
  sessionId?: string;
  onProgress?: (done: number, total: number) => void;
};

export type EvalPlan = {
  resolved: ResolvedModel;
  /** The providers the run may use: the primary, then its fallback. */
  chain: ResolvedModel[];
  total: number;
  cached: number;
  /** Real calls if every first try works. Retries, repairs and fallbacks add to it. */
  calls: number;
};

/** What a run will cost before it starts: how many real calls it makes. */
export function planEval(rows: readonly GoldenRow[], opts: Pick<EvalOptions, "version" | "provider" | "cache" | "refresh">): EvalPlan {
  if (rows.length === 0) throw new Error("No tickets to run.");
  let cached = 0;
  let chain: ResolvedModel[] = [];
  for (const row of rows) {
    const { prompt, parts } = firstTryKeyParts(row.text, opts.version);
    chain = resolveChain(loadModelsConfig(), prompt.model, opts.provider);
    const primary = chain[0];
    if (!primary) throw new Error("No model to run.");
    if (!opts.refresh && opts.cache.get(cacheKey({ ...parts, provider: primary.provider, model: primary.model, params: primary.params }))) cached++;
  }
  const [resolved] = chain;
  if (!resolved) throw new Error("No model to run.");
  return { resolved, chain, total: rows.length, cached, calls: rows.length - cached };
}

export type EvalOutcome = {
  records: TicketRecord[];
  /** Set when the run stopped early: a rate limit, or an error every other call would hit too. */
  stoppedBy?: ProviderError;
};

// These reach the eval only after the gateway has retried and fallen back.
// A 429 means the free tier is used up for now; a bad key (auth) or an unknown
// model (404) will fail on every ticket. Either way, going on only burns
// quota. Any other 4xx can be about one ticket: Cohere answers some with a 422
// "No valid response generated". That is recorded as a failed ticket and the
// run goes on, unless it keeps happening, which means it is the request, not
// the ticket.
const FAILS_EVERY_TICKET = new Set([404]);
export const MAX_BAD_REQUESTS_IN_A_ROW = 3;

export function stopsTheRun(err: ProviderError, badRequestsInARow: number): boolean {
  if (err.errorClass === "rate_limit" || err.errorClass === "auth" || err.errorClass === "circuit_open") return true;
  if (err.errorClass !== "bad_request") return false;
  return (err.status !== undefined && FAILS_EVERY_TICKET.has(err.status)) || badRequestsInARow >= MAX_BAD_REQUESTS_IN_A_ROW;
}

// One trace per ticket, all of a run's under one session, so a dev mistake
// in the results file leads to its trace by trace_id.
async function runOne(row: GoldenRow, opts: EvalOptions): Promise<{ record: TicketRecord; err?: ProviderError }> {
  const { span, ctx } = startRoot(
    "eval.ticket",
    // The golden labels go along, so a wrong answer reads against the right one in Langfuse.
    { attributes: { "app.ticket_id": row.id, "app.source": row.source, "app.expected_category": row.category, "app.expected_priority": row.priority } },
    {
      ...(opts.sessionId ? { "langfuse.session.id": opts.sessionId, "session.id": opts.sessionId } : {}),
      "langfuse.release": gitSha(),
      "langfuse.version": opts.version,
      "app.prompt_version": opts.version,
      "app.git_sha": gitSha(),
    },
  );
  const tid = traceId(span);
  try {
    const { record, err } = await context.with(ctx, () => gradeOne(row, opts));
    span.setAttributes({
      "app.category_ok": record.grade.category,
      "app.priority_ok": record.grade.priority,
      ...(record.provider ? { "app.provider": record.provider } : {}),
      "app.fallback": record.fallback ?? false,
      ...(record.error ? { "app.error_class": record.error.class } : {}),
    });
    if (record.answer) labelsOut(span, record.answer);
    if (record.error) failSpan(span, record.error.class);
    return { record: tid ? { ...record, trace_id: tid } : record, ...(err ? { err } : {}) };
  } finally {
    span.end();
  }
}

async function gradeOne(row: GoldenRow, opts: EvalOptions): Promise<{ record: TicketRecord; err?: ProviderError }> {
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
      provider: r.provider,
      fallback: r.fallback,
      retries: r.retries,
      repaired: r.repaired,
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
