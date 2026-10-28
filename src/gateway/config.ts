import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { paths, rel } from "../paths.js";

export const PROVIDERS = ["gemini", "cohere", "mock", "mock_fallback"] as const;
export const ProviderNameSchema = z.enum(PROVIDERS);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

/** The two in-process mocks: no key, no network. */
export const isMock = (p: ProviderName): p is "mock" | "mock_fallback" => p === "mock" || p === "mock_fallback";

const ProviderSchema = z.strictObject({
  base_url: z.url(),
  key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  key_url: z.url().optional(),
  /** The provider's free-tier requests per minute; calls are spaced to stay under it. */
  rpm: z.number().int().positive().optional(),
  /** gen_ai.provider.name in traces, from the GenAI conventions' list. Unset: the provider's name here. */
  otel_name: z.string().min(1).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

// Extra request parameters a model needs (e.g. reasoning_effort). They belong
// to the model, not the prompt, because another provider may reject them.
const ModelParamsSchema = z.strictObject({
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});
export type ModelParams = z.infer<typeof ModelParamsSchema>;

const AliasSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

const ModelSchema = z.strictObject({
  provider: ProviderNameSchema,
  model: z.string().min(1),
  params: ModelParamsSchema.default({}),
  /** The alias that answers when this one can't. */
  fallback: AliasSchema.optional(),
});

const PriceSchema = z.strictObject({ input: z.number().nonnegative(), output: z.number().nonnegative() });
export type Price = z.infer<typeof PriceSchema>;

const Ms = z.number().int().positive();
const GatewayConfigSchema = z
  .strictObject({
    attempt_timeout_ms: Ms,
    deadline_ms: Ms,
    max_retries: z.number().int().min(0).max(5),
    backoff_base_ms: Ms,
    backoff_cap_ms: Ms,
    circuit: z.strictObject({ failures: z.number().int().positive(), window_ms: Ms, open_ms: Ms }),
  })
  .refine((g) => g.attempt_timeout_ms <= g.deadline_ms, { message: "attempt_timeout_ms can't be longer than deadline_ms" })
  .refine((g) => g.backoff_base_ms <= g.backoff_cap_ms, { message: "backoff_base_ms can't be bigger than backoff_cap_ms" });
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

const ModelsFileSchema = z
  .strictObject({
    providers: z.strictObject({ gemini: ProviderSchema, cohere: ProviderSchema, mock: ProviderSchema, mock_fallback: ProviderSchema }),
    models: z.record(AliasSchema, ModelSchema),
    gateway: GatewayConfigSchema,
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
      if (!isMock(m.provider) && !file.providers[m.provider].key_env) {
        ctx.addIssue({ code: "custom", path: ["providers", m.provider], message: "a real provider needs key_env" });
      }
      if (m.fallback !== undefined) {
        const fb = file.models[m.fallback];
        const path = ["models", alias, "fallback"];
        if (!fb) ctx.addIssue({ code: "custom", path, message: `fallback alias "${m.fallback}" is not in models` });
        // One fallback, never a chain: the deadline only has room for two providers.
        else if (fb.fallback !== undefined) ctx.addIssue({ code: "custom", path, message: `fallback "${m.fallback}" has a fallback of its own` });
        // Same provider means same outage and same circuit: no fallback at all.
        else if (fb.provider === m.provider) ctx.addIssue({ code: "custom", path, message: `fallback "${m.fallback}" is on the same provider` });
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

function resolveAlias(config: ModelsConfig, name: string): ResolvedModel {
  const m = config.models[name];
  if (!m) throw new Error(`Model alias "${name}" is not in ${rel(paths.models)}.`);
  const price = config.prices.models[m.model];
  if (!price) throw new Error(`No price for ${m.model} in ${rel(paths.models)}.`);
  return { alias: name, provider: m.provider, model: m.model, params: m.params, price, priceDate: config.prices.date };
}

/**
 * Which model a call uses. Normally the prompt's alias decides; `--provider`
 * overrides it with the first alias that points at that provider.
 */
export function resolveModel(config: ModelsConfig, alias: string, provider?: ProviderName): ResolvedModel {
  if (!provider) return resolveAlias(config, alias);
  const entry = Object.entries(config.models).find(([, m]) => m.provider === provider);
  if (!entry) throw new Error(`No model in ${rel(paths.models)} uses provider ${provider}.`);
  return resolveAlias(config, entry[0]);
}

/**
 * The providers a call may use, in order: the model from resolveModel, then
 * its fallback if it has one. `--provider cohere` lands on the `fallback`
 * alias, which has none, so that eval measures Cohere alone.
 */
export function resolveChain(config: ModelsConfig, alias: string, provider?: ProviderName): ResolvedModel[] {
  const primary = resolveModel(config, alias, provider);
  const fallback = config.models[primary.alias]?.fallback;
  return fallback ? [primary, resolveAlias(config, fallback)] : [primary];
}
