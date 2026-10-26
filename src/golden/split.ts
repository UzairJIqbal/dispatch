import { createHash } from "node:crypto";
import type { Split } from "./schema.js";

export const DEV_PERCENT = 75;

// The split is a pure function of the id, so a ticket can never be moved to
// the other side by hand, and adding tickets later doesn't reshuffle old ones.
export function splitFor(id: string): Split {
  const bucket = createHash("sha256").update(id).digest().readUInt32BE(0) % 100;
  return bucket < DEV_PERCENT ? "dev" : "test";
}
