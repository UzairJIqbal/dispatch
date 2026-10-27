import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { CATEGORIES } from "../categories.js";
import { paths, rel } from "../paths.js";

export const PromptVersionSchema = z.string().regex(/^v\d+$/, "a prompt version looks like v1, v2, ...");

const PromptFileSchema = z
  .strictObject({
    version: PromptVersionSchema,
    model: z.string().min(1),
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().positive().max(8000),
    system: z.string().min(1),
    user: z.string().includes("{{ticket}}", { message: "must contain {{ticket}} where the ticket goes" }),
  })
  .refine((p) => !p.system.includes("{{ticket}}"), { message: "the ticket goes in `user`, never in `system`" });

export type PromptFile = z.infer<typeof PromptFileSchema> & {
  /** Hash of the whole file: part of the cache key, so editing an unreleased file can't serve stale answers. */
  sha256: string;
};

export function parsePrompt(text: string, expectedVersion: string, file: string): PromptFile {
  const parsed = PromptFileSchema.safeParse(parse(text));
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  if (parsed.data.version !== expectedVersion) {
    throw new Error(`${file} says version ${parsed.data.version}; the file name says ${expectedVersion}.`);
  }
  return { ...parsed.data, sha256: createHash("sha256").update(text).digest("hex") };
}

export function promptVersions(): string[] {
  if (!existsSync(paths.prompts)) return [];
  return readdirSync(paths.prompts)
    .map((f) => /^(v\d+)\.yaml$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

const loaded = new Map<string, PromptFile>();

export function loadPrompt(version: string): PromptFile {
  const hit = loaded.get(version);
  if (hit) return hit;
  PromptVersionSchema.parse(version);
  const file = `${paths.prompts}/${version}.yaml`;
  if (!existsSync(file)) {
    throw new Error(`No prompt ${rel(file)}. Versions available: ${promptVersions().join(", ") || "none"}.`);
  }
  const prompt = parsePrompt(readFileSync(file, "utf8"), version, rel(file));
  loaded.set(version, prompt);
  return prompt;
}

/** The newest prompt file, the default when no --version is given. */
export function latestPromptVersion(): string {
  const v = promptVersions().at(-1);
  if (!v) throw new Error(`No prompt files in ${rel(paths.prompts)}.`);
  return v;
}

// A ticket can't close the fence early: any <ticket> or </ticket> it contains
// is defanged before it goes in.
function fence(text: string): string {
  return text.replace(/<(\/?)ticket>/gi, "‹$1ticket›");
}

export function renderPrompt(prompt: PromptFile, ticket: string): { system: string; user: string } {
  return {
    system: prompt.system.replaceAll("{{categories}}", CATEGORIES.join(", ")),
    user: prompt.user.replace("{{ticket}}", () => fence(ticket)),
  };
}
