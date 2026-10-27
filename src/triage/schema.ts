import { z } from "zod";
import { CategorySchema } from "../categories.js";
import { PrioritySchema } from "../golden/schema.js";

export const MAX_SUMMARY_CHARS = 120;

// Closed: an extra key is a schema_fail, so a ticket can at worst change a
// label, never the shape of the answer.
export const TriageAnswerSchema = z.strictObject({
  category: CategorySchema,
  priority: PrioritySchema,
  summary: z.string().trim().min(1).max(MAX_SUMMARY_CHARS),
});
export type TriageAnswer = z.infer<typeof TriageAnswerSchema>;
