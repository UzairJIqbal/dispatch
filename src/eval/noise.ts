import type { TicketRecord } from "./results.js";

const labelOf = (r: TicketRecord) => `${r.answer?.category ?? "?"}/${r.answer?.priority ?? "?"}`;

/**
 * How many tickets changed between two identical runs. Temperature 0 still
 * isn't fully deterministic on shared hardware, so this measures how far a
 * number can move by chance. The CI gate's threshold is never below it.
 *
 * Only tickets answered in both runs are compared. A timeout or a 5xx is the
 * provider having a bad minute, not the model changing its mind; counting it
 * as a flip once made the floor 20 of 74 and the gate useless.
 */
export function compareRuns(
  a: readonly TicketRecord[],
  b: readonly TicketRecord[],
): { compared: number; flips: number; both_flips: number; flipped_ids: string[]; failed_ids: string[] } {
  const second = new Map(b.map((r) => [r.id, r]));
  const flipped: string[] = [];
  const failed: string[] = [];
  let bothFlips = 0;
  for (const r of a) {
    const other = second.get(r.id);
    if (!other) throw new Error(`Ticket ${r.id} is in the first run but not the second.`);
    if (r.error || other.error) {
      failed.push(r.id);
      continue;
    }
    if (labelOf(r) !== labelOf(other)) flipped.push(r.id);
    if (r.grade.both !== other.grade.both) bothFlips++;
  }
  return { compared: a.length - failed.length, flips: flipped.length, both_flips: bothFlips, flipped_ids: flipped, failed_ids: failed };
}
