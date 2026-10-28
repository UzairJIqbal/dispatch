// The shape of results/<run>.json, results/baseline.json and
// results/noise.json. Files are the record, so they are read back through Zod
// like any other input.
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CategorySchema } from "../categories.js";
import { ERROR_CLASSES } from "../gateway/errors.js";
import { ProviderNameSchema } from "../gateway/config.js";
import { PrioritySchema, SOURCES, SplitSchema } from "../golden/schema.js";
import { writeAtomic } from "../golden/files.js";
import { paths, rel } from "../paths.js";
import { TriageAnswerSchema } from "../triage/schema.js";

const Pct = z.number().min(0).max(100);
const Count = z.number().int().nonnegative();

export const TicketRecordSchema = z.strictObject({
  id: z.string(),
  source: z.enum(SOURCES),
  expected: z.strictObject({ category: CategorySchema, priority: PrioritySchema }),
  answer: TriageAnswerSchema.nullable(),
  error: z.strictObject({ class: z.enum(ERROR_CLASSES), message: z.string() }).nullable(),
  /** The model's text when it failed the schema, for error analysis. */
  raw: z.string().optional(),
  grade: z.strictObject({
    category: z.boolean(),
    priority: z.boolean(),
    both: z.boolean(),
    dangerous_miss: z.boolean(),
    summary: z.strictObject({ present: z.boolean(), length_ok: z.boolean(), numbers_ok: z.boolean(), ok: z.boolean() }).nullable(),
  }),
  cached: z.boolean(),
  // From Phase 4 on. Optional so results files written before it still read.
  /** Who answered: the primary, or the fallback when `fallback` is true. */
  provider: ProviderNameSchema.optional(),
  fallback: z.boolean().optional(),
  retries: Count.optional(),
  /** The first answer failed validation and was sent back once. */
  repaired: z.boolean().optional(),
  latency_ms: Count.nullable(),
  tokens_in: Count,
  tokens_out: Count,
  /** From Phase 5 on: the ticket's trace in Langfuse, absent when tracing was off or sampled out. */
  trace_id: z.string().optional(),
});
export type TicketRecord = z.infer<typeof TicketRecordSchema>;

const Rate = z.strictObject({ pct: Pct, k: Count, n: Count });
export type Rate = z.infer<typeof Rate>;

export const MetricsSchema = z.strictObject({
  n: Count,
  both: Rate,
  category: Rate,
  priority: Rate,
  dangerous_misses: Count,
  /** Answers that passed Zod first try, without a repair. */
  schema_valid: Rate,
  success: Rate,
  summary_ok: Rate,
  by_source: z.record(z.string(), Rate),
  errors: z.record(z.string(), Count),
  calls: z.strictObject({ cached: Count, uncached: Count, failed: Count }),
  /** Seconds, from uncached calls only. Null when every call was cached. */
  latency_s: z.strictObject({ n: Count, p50: z.number(), p95: z.number(), p99: z.number() }).nullable(),
  tokens: z.strictObject({ in_avg: z.number(), out_avg: z.number(), in_total: Count, out_total: Count }),
  cost_usd: z.strictObject({ per_request: z.number(), total: z.number(), price_date: z.iso.date() }),
  /** What the gateway did. Absent in results files from before Phase 4. */
  gateway: z.strictObject({ retries: Count, fallbacks: Count, repairs: Count }).optional(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

export const RunInfoSchema = z.strictObject({
  id: z.string(),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  split: SplitSchema,
  prompt_version: z.string(),
  provider: ProviderNameSchema,
  model: z.string(),
  dataset_version: z.string(),
  git_sha: z.string(),
  cache: z.enum(["used", "skipped"]),
});
export type RunInfo = z.infer<typeof RunInfoSchema>;

export const NoiseSchema = z.strictObject({
  prompt_version: z.string(),
  provider: ProviderNameSchema,
  model: z.string(),
  dataset_version: z.string(),
  split: SplitSchema,
  measured_at: z.iso.datetime(),
  git_sha: z.string(),
  n: Count,
  /** Tickets answered in both runs; flips are counted over these only. */
  compared: Count,
  /** Tickets whose category or priority differed between two identical uncached runs. */
  flips: Count,
  /** Tickets whose both-correct verdict changed: how far the headline number can move by chance. */
  both_flips: Count,
  flipped_ids: z.array(z.string()),
  /** Failed or answered by the fallback in either run: left out of the flips, listed so nothing hides. */
  failed_ids: z.array(z.string()),
  both_correct: z.tuple([Rate, Rate]),
});
export type Noise = z.infer<typeof NoiseSchema>;

export const ResultsFileSchema = z.strictObject({
  run: RunInfoSchema,
  metrics: MetricsSchema,
  noise_floor: NoiseSchema.optional(),
  tickets: z.array(TicketRecordSchema),
});
export type ResultsFile = z.infer<typeof ResultsFileSchema>;

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`${rel(file)} is not valid JSON.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${rel(file)} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

export const runFileName = (run: RunInfo): string =>
  `${paths.results}/${run.started_at.replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}-${run.prompt_version}-${run.split}.json`;

export async function readBaseline(): Promise<ResultsFile | undefined> {
  return existsSync(paths.baseline) ? readJson(paths.baseline, ResultsFileSchema) : undefined;
}

export async function readNoise(): Promise<Noise | undefined> {
  return existsSync(paths.noise) ? readJson(paths.noise, NoiseSchema) : undefined;
}

/**
 * What a run is compared against. A test run: the baseline. A dev run: the
 * baseline is test-only, so the latest earlier dev run on the same provider
 * (that's how v2 is compared with v1 while tuning).
 */
export async function findComparison(run: RunInfo): Promise<{ label: string; file: ResultsFile } | undefined> {
  if (run.split === "test") {
    const baseline = await readBaseline();
    return baseline ? { label: `baseline (${baseline.run.prompt_version}, ${baseline.run.provider})`, file: baseline } : undefined;
  }
  if (!existsSync(paths.results)) return undefined;
  const names = readdirSync(paths.results)
    .filter((f) => /^\d{4}-.*-dev\.json$/.test(f))
    .sort()
    .reverse();
  for (const name of names) {
    const file = await readJson(`${paths.results}/${name}`, ResultsFileSchema);
    if (file.run.provider === run.provider && file.run.id !== run.id && file.run.started_at < run.started_at) {
      return { label: `previous dev run (${file.run.prompt_version}, ${name.slice(0, 20)})`, file };
    }
  }
  return undefined;
}
