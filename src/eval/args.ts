import { parseArgs } from "node:util";
import { z } from "zod";
import { ProviderNameSchema } from "../gateway/config.js";
import { SplitSchema } from "../golden/schema.js";
import { PromptVersionSchema, latestPromptVersion } from "../triage/prompt.js";

const USAGE = "Usage: pnpm eval --split dev|test [--version v1] [--provider mock|gemini|cohere] [--no-cache] [--write-baseline]";

const EvalArgsSchema = z.strictObject({
  split: SplitSchema,
  version: PromptVersionSchema.optional(),
  provider: ProviderNameSchema.optional(),
  "no-cache": z.boolean().default(false),
  "write-baseline": z.boolean().default(false),
});

export type EvalArgs = {
  split: z.infer<typeof SplitSchema>;
  version: string;
  provider?: z.infer<typeof ProviderNameSchema>;
  noCache: boolean;
  writeBaseline: boolean;
};

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  let values: unknown;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        split: { type: "string" },
        version: { type: "string" },
        provider: { type: "string" },
        "no-cache": { type: "boolean" },
        "write-baseline": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, { cause: err });
  }
  const parsed = EvalArgsSchema.safeParse(values);
  if (!parsed.success) throw new Error(`${z.prettifyError(parsed.error)}\n${USAGE}`);
  const a = parsed.data;
  return {
    split: a.split,
    version: a.version ?? latestPromptVersion(),
    ...(a.provider ? { provider: a.provider } : {}),
    noCache: a["no-cache"],
    writeBaseline: a["write-baseline"],
  };
}

const NoiseArgsSchema = z.strictObject({ version: PromptVersionSchema.optional(), provider: ProviderNameSchema.optional() });

export function parseNoiseArgs(argv: readonly string[]): { version: string; provider?: z.infer<typeof ProviderNameSchema> } {
  const usage = "Usage: pnpm eval:noise [--version v1] [--provider mock|gemini|cohere]";
  let values: unknown;
  try {
    ({ values } = parseArgs({ args: [...argv], options: { version: { type: "string" }, provider: { type: "string" } }, strict: true }));
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${usage}`, { cause: err });
  }
  const parsed = NoiseArgsSchema.safeParse(values);
  if (!parsed.success) throw new Error(`${z.prettifyError(parsed.error)}\n${usage}`);
  return { version: parsed.data.version ?? latestPromptVersion(), ...(parsed.data.provider ? { provider: parsed.data.provider } : {}) };
}
