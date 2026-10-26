import { z } from "zod";
import { CategorySchema } from "../categories.js";

export const PRIORITIES = ["low", "medium", "high"] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

export const SPLITS = ["dev", "test"] as const;
export const SplitSchema = z.enum(SPLITS);
export type Split = z.infer<typeof SplitSchema>;

export const SOURCES = ["bitext", "messy"] as const;

// Same limit the service will enforce on incoming tickets.
export const MAX_TICKET_CHARS = 4000;
const TicketText = z.string().trim().min(1).max(MAX_TICKET_CHARS);
const Note = z.string().trim().min(1).max(200);

/** A ticket before it has a priority: one row of evals/tickets.jsonl. */
export const TicketSchema = z.strictObject({
  id: z.string().regex(/^(bitext-[0-9a-f]{10}|messy-\d{2})$/),
  source: z.enum(SOURCES),
  category: CategorySchema,
  text: TicketText,
});
export type Ticket = z.infer<typeof TicketSchema>;

/** A ticket written by hand in evals/messy-tickets.json. */
export const MessyTicketSchema = TicketSchema.omit({ source: true });

export const LabelSchema = z.strictObject({
  priority: PrioritySchema,
  note: Note.optional(),
});
export type Label = z.infer<typeof LabelSchema>;

/** evals/labels.json: priorities typed in with `pnpm label`, keyed by ticket id. */
export const LabelsFileSchema = z.record(z.string(), LabelSchema);
export type Labels = z.infer<typeof LabelsFileSchema>;

export const GoldenRowSchema = z.strictObject({
  id: TicketSchema.shape.id,
  source: TicketSchema.shape.source,
  split: SplitSchema,
  category: CategorySchema,
  priority: PrioritySchema,
  note: Note.optional(),
  text: TicketText,
});
export type GoldenRow = z.infer<typeof GoldenRowSchema>;

/** First line of evals/golden.jsonl. */
export const GoldenHeaderSchema = z.strictObject({
  dataset_version: z.string().regex(/^v\d+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rows: z.number().int().positive(),
});
export type GoldenHeader = z.infer<typeof GoldenHeaderSchema>;
