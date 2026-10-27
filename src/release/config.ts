import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { paths, rel } from "../paths.js";
import { loadPrompt, PromptVersionSchema } from "../triage/prompt.js";

// Which prompt version is live. For now only `stable`; the canary and its
// traffic share arrive with the release config in Redis (Phase 9).
const ReleaseFileSchema = z.strictObject({
  stable: PromptVersionSchema,
});
export type ReleaseConfig = z.infer<typeof ReleaseFileSchema>;

export function parseReleaseConfig(text: string, file = rel(paths.release)): ReleaseConfig {
  const parsed = ReleaseFileSchema.safeParse(parse(text));
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Reads the release file and checks the version it names really exists, so a typo fails at startup. */
export function loadReleaseConfig(file = paths.release): ReleaseConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No release config at ${rel(file)}. It needs one line naming the live prompt, e.g. \`stable: v2\`.`);
  }
  const config = parseReleaseConfig(text, rel(file));
  loadPrompt(config.stable);
  return config;
}
