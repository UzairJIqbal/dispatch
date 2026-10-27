import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { paths, rel } from "../paths.js";

export const PROVIDERS = ["gemini", "cohere", "mock"] as const;
export const ProviderNameSchema = z.enum(PROVIDERS);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

const ProviderSchema = z.strictObject({
  base_url: z.url(),
  key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  key_url: z.url().optional(),
  /** The provider's free-tier requests per minute; calls are spaced to stay under it. */
  rpm: z.number().int().positive().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

// Extra request parameters a model needs (e.g. reasoning_effort). They belong
// to the model, not the prompt, because another provider may reject them.
const ModelParamsSchema = z.strictObject({
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});
export type ModelParams = z.infer<typeof ModelParamsSchema>;

const ModelSchema = z.strictObject({
  provider: ProviderNameSchema,
  model: z.string().min(1),
  params: ModelParamsSchema.default({}),
});

const PriceSchema = z.strictObject({ input: z.number().nonnegative(), output: z.number().nonnegative() });
export type Price = z.infer<typeof PriceSchema>;

const ModelsFileSchema = z
  .strictObject({
    providers: z.strictObject({ gemini: ProviderSchema, cohere: ProviderSchema, mock: ProviderSchema }),
    models: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), ModelSchema),
    prices: z.strictObject({
      date: z.iso.date(),
      source: z.string().min(1),
      models: z.record(z.string(), PriceSchema),
    }),
  })
  .superRefine((file, ctx) => {
    for (const [alias, m] of Object.entries(file.models)) {
      if (!(m.model in file.prices.models)) {
        ctx.addIssue({ code: "custom", path: ["prices", "models"], message: `no price for ${m.model} (alias ${alias})` });
      }
      if (m.provider !== "mock" && !file.providers[m.provider].key_env) {
        ctx.addIssue({ code: "custom", path: ["providers", m.provider], message: "a real provider needs key_env" });
      }
    }
    for (const p of PROVIDERS) {
      if (!Object.values(file.models).some((m) => m.provider === p)) {
        ctx.addIssue({ code: "custom", path: ["models"], message: `no model alias uses provider ${p}` });
      }
    }
  });
export type ModelsConfig = z.infer<typeof ModelsFileSchema>;

export function parseModelsConfig(text: string, file = rel(paths.models)): ModelsConfig {
  const parsed = ModelsFileSchema.safeParse(parse(text));
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

let cached: ModelsConfig | undefined;
export function loadModelsConfig(): ModelsConfig {
  cached ??= parseModelsConfig(readFileSync(paths.models, "utf8"));
  return cached;
}

export type ResolvedModel = {
  alias: string;
  provider: ProviderName;
  model: string;
  params: ModelParams;
  price: Price;
  priceDate: string;
};

/**
 * Which model a call uses. Normally the prompt's alias decides; `--provider`
 * overrides it with the first alias that points at that provider.
 */
export function resolveModel(config: ModelsConfig, alias: string, provider?: ProviderName): ResolvedModel {
  const entry = provider
    ? Object.entries(config.models).find(([, m]) => m.provider === provider)
    : Object.entries(config.models).find(([a]) => a === alias);
  if (!entry) {
    throw new Error(provider ? `No model in ${rel(paths.models)} uses provider ${provider}.` : `Model alias "${alias}" is not in ${rel(paths.models)}.`);
  }
  const [name, m] = entry;
  const price = config.prices.models[m.model];
  if (!price) throw new Error(`No price for ${m.model} in ${rel(paths.models)}.`);
  return { alias: name, provider: m.provider, model: m.model, params: m.params, price, priceDate: config.prices.date };
}
