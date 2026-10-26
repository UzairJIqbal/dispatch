import { z } from "zod";

// The one list of ticket categories. The golden set, the response schema, the
// prompt and the grader all read it from here.
//
// Taken from the Bitext dataset itself, lowercased. The project spec guessed
// `newsletter`; the dataset calls that category SUBSCRIPTION (its only intent
// is newsletter_subscription), so `subscription` it is. The import stops if the
// dataset's list ever stops matching this one.
export const CATEGORIES = [
  "account",
  "cancel",
  "contact",
  "delivery",
  "feedback",
  "invoice",
  "order",
  "payment",
  "refund",
  "shipping",
  "subscription",
] as const;

export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;
