// Pure functions from a ticket's expected labels (and its text, for the
// summary's numbers) and the model's answer to a verdict per field. No judge
// model, nothing to mock.
import type { Category } from "../categories.js";
import type { Priority } from "../golden/schema.js";
import { MAX_SUMMARY_CHARS, type TriageAnswer } from "../triage/schema.js";

export type Expected = { category: Category; priority: Priority };

export type SummaryVerdict = {
  present: boolean;
  length_ok: boolean;
  /** Every number in the summary also appears in the ticket: no invented order numbers. */
  numbers_ok: boolean;
  ok: boolean;
};

export type Grade = {
  category: boolean;
  priority: boolean;
  both: boolean;
  dangerous_miss: boolean;
  summary: SummaryVerdict | null;
};

export const gradeCategory = (expected: Expected, answer: TriageAnswer): boolean => answer.category === expected.category;
export const gradePriority = (expected: Expected, answer: TriageAnswer): boolean => answer.priority === expected.priority;

/** A high ticket labelled low: the mistake that costs a real customer. */
export const isDangerousMiss = (expected: Expected, answer: TriageAnswer): boolean =>
  expected.priority === "high" && answer.priority === "low";

export function numbersIn(text: string): string[] {
  return text.match(/\d+(?:[.,:/-]\d+)*/g) ?? [];
}

export function checkSummary(summary: string, ticket: string): SummaryVerdict {
  const present = summary.trim().length > 0;
  const length_ok = summary.length <= MAX_SUMMARY_CHARS;
  const numbers_ok = numbersIn(summary).every((n) => ticket.includes(n));
  return { present, length_ok, numbers_ok, ok: present && length_ok && numbers_ok };
}

/**
 * The verdict for one ticket. No answer (schema_fail or a failed call) is
 * wrong on every field; it is not a dangerous miss, because nothing was
 * labelled low. It shows up in the success rate instead.
 */
export function gradeTicket(expected: Expected, ticket: string, answer: TriageAnswer | null): Grade {
  if (!answer) return { category: false, priority: false, both: false, dangerous_miss: false, summary: null };
  const category = gradeCategory(expected, answer);
  const priority = gradePriority(expected, answer);
  return {
    category,
    priority,
    both: category && priority,
    dangerous_miss: isDangerousMiss(expected, answer),
    summary: checkSummary(answer.summary, ticket),
  };
}
