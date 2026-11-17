// The cost model behind `pnpm cost`: measured tokens from an eval run, times the
// dated list prices. Pure functions, so the arithmetic is tested without a
// results file. The free tiers cost $0; these are what the same traffic would
// cost on a paid plan.
import type { Price, ProviderName } from "../gateway/config.js";
import { usd } from "../eval/report.js";
import type { TicketRecord } from "../eval/results.js";

/** The projection the spec asks for: a 30-day month at this many tickets a day. */
export const TICKETS_PER_DAY = 10_000;
const DAYS = 30;

export type ModelPrice = { provider: ProviderName; model: string; price: Price };

export type ModelCost = {
  provider: ProviderName;
  model: string;
  price: Price;
  /** Requests the average is over. Failed requests that still used tokens are in it. */
  requests: number;
  successes: number;
  avgIn: number;
  avgOut: number;
  perRequest: number;
  /** Everything spent (failures too) divided over the successes. */
  per1000Successes: number;
  monthly: number;
  /** Share of the money that is input tokens: the "what dominates" answer. */
  inputShare: number;
  /** true: no run on file for this provider, so the primary's measured tokens were priced at this model's rates. */
  assumedTokens: boolean;
};

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Tokens count only for calls that reached a provider: a ticket that never got one has none. */
const costed = (records: readonly TicketRecord[]) => records.filter((r) => r.latency_ms !== null);

export function costFor(records: readonly TicketRecord[], m: ModelPrice, assumedTokens: boolean): ModelCost {
  const called = costed(records);
  if (called.length === 0) throw new Error(`No calls in the results to price (provider ${m.provider}).`);
  const successes = called.filter((r) => r.answer !== null).length;
  const tokensIn = sum(called.map((r) => r.tokens_in));
  const tokensOut = sum(called.map((r) => r.tokens_out));
  const inCost = (tokensIn * m.price.input) / 1_000_000;
  const outCost = (tokensOut * m.price.output) / 1_000_000;
  const total = inCost + outCost;
  // Failed requests still cost tokens, so they are in the total but not in the divisor.
  const per1000 = successes === 0 ? Number.NaN : (total / successes) * 1000;
  return {
    provider: m.provider,
    model: m.model,
    price: m.price,
    requests: called.length,
    successes,
    avgIn: tokensIn / called.length,
    avgOut: tokensOut / called.length,
    perRequest: total / called.length,
    per1000Successes: per1000,
    monthly: (per1000 / 1000) * TICKETS_PER_DAY * DAYS,
    inputShare: total === 0 ? 0 : inCost / total,
    assumedTokens,
  };
}

/**
 * Primary and fallback, each from its own records if the run has any, else from
 * the primary's tokens (a Cohere run isn't on file; its tokenizer differs, so
 * that row is marked as an assumption).
 */
export function costModel(records: readonly TicketRecord[], chain: readonly ModelPrice[]): ModelCost[] {
  const [primary] = chain;
  if (!primary) throw new Error("No model to price.");
  const own = (p: ProviderName) => records.filter((r) => (r.provider ?? primary.provider) === p);
  const primaryRecords = own(primary.provider);
  return chain.map((m, i) => {
    if (i === 0) return costFor(primaryRecords, m, false);
    const mine = own(m.provider);
    // The fallback answered only a handful (if any): too few to say anything about its own tokens.
    return costed(mine).length >= 30 ? costFor(mine, m, false) : costFor(primaryRecords, m, true);
  });
}

/**
 * Of the average input, how much is the same every request (system prompt) and
 * how much is the ticket. A ticket is estimated at 4 characters a token.
 */
export function inputSplit(avgIn: number, avgTicketChars: number): { fixed: number; ticket: number; fixedShare: number } {
  const ticket = Math.min(avgIn, avgTicketChars / 4);
  return { fixed: avgIn - ticket, ticket, fixedShare: avgIn === 0 ? 0 : (avgIn - ticket) / avgIn };
}

const usd2 = (x: number) => (Number.isNaN(x) ? "n/a" : `$${x.toFixed(2)}`);
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;

export type CostReport = {
  runLabel: string;
  priceDate: string;
  models: ModelCost[];
  split?: { fixed: number; ticket: number; fixedShare: number };
  /** Another run of the same prompt, for the before/after of an experiment. */
  against?: { label: string; models: ModelCost[] };
};

export function formatCost(r: CostReport): string {
  const head = ["", ...r.models.map((m) => `${m.provider} ${m.model}`)];
  const rows: string[][] = [
    head,
    ["list price in / out per 1M tokens", ...r.models.map((m) => `$${m.price.input.toFixed(2)} / $${m.price.output.toFixed(2)}`)],
    ["requests priced (n)", ...r.models.map((m) => `${String(m.requests)}${m.assumedTokens ? " (primary's tokens, assumed)" : ""}`)],
    ["avg input tokens", ...r.models.map((m) => m.avgIn.toFixed(0))],
    ["avg output tokens", ...r.models.map((m) => m.avgOut.toFixed(0))],
    ["cost per request", ...r.models.map((m) => usd(m.perRequest))],
    ["cost per 1,000 successful requests", ...r.models.map((m) => usd2(m.per1000Successes))],
    [`monthly at ${TICKETS_PER_DAY.toLocaleString("en-US")} tickets/day (${String(DAYS)} days)`, ...r.models.map((m) => usd2(m.monthly))],
    ["input tokens' share of the cost", ...r.models.map((m) => pct(m.inputShare))],
  ];
  const widths = head.map((_, c) => Math.max(...rows.map((row) => (row[c] ?? "").length)));
  const lines = rows.map((row) => row.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ").trimEnd());

  const out = [`Cost model from ${r.runLabel}.`, "", ...lines, ""];
  const [primary] = r.models;
  if (primary) {
    out.push(
      `What dominates: input tokens, ${pct(primary.inputShare)} of the primary's cost` +
        (r.split ? `; about ${r.split.fixed.toFixed(0)} of the ${primary.avgIn.toFixed(0)} input tokens (${pct(r.split.fixedShare)}) are the system prompt, sent unchanged with every ticket (ticket text estimated at 4 characters a token).` : "."),
    );
  }
  if (r.against) {
    out.push("", `Against ${r.against.label}:`);
    r.models.forEach((m, i) => {
      const b = r.against?.models[i];
      if (!b) return;
      out.push(
        `  ${m.provider}: input ${b.avgIn.toFixed(0)} → ${m.avgIn.toFixed(0)} tokens, ${usd2(b.per1000Successes)} → ${usd2(m.per1000Successes)} per 1,000 successes, ${usd2(b.monthly)} → ${usd2(m.monthly)} a month.`,
      );
    });
  }
  out.push(
    "",
    `List-price estimate, price table dated ${r.priceDate}. The real bill was $0: both providers ran on free tiers.`,
    "Failed requests still cost tokens: they are in the total and not in the 1,000.",
  );
  return out.join("\n");
}
