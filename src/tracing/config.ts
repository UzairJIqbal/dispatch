import { z } from "zod";

// Tracing's settings, from the environment. Shared by the service and the
// eval. A bad value stops the process with the variable's name; missing
// Langfuse keys don't: tracing is never a reason not to serve.

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const EnvSchema = z.object({
  /** Share of requests traced, 0 to 1. 1 normally; 0.1 for load tests. */
  TRACE_SAMPLE_RATE: optional(z.coerce.number().min(0).max(1)),
  /** Local debugging only: puts the (redacted) ticket and answer in spans. */
  TRACE_CAPTURE_CONTENT: optional(z.enum(["true", "false"])),
  // Not checked for shape: a wrong key must cost a warning, never the service.
  LANGFUSE_PUBLIC_KEY: optional(z.string()),
  LANGFUSE_SECRET_KEY: optional(z.string()),
  LANGFUSE_BASE_URL: optional(z.url({ protocol: /^https?$/, message: "must be the Langfuse host, e.g. https://cloud.langfuse.com" })),
  NODE_ENV: optional(z.string()),
});

export type TracingConfig = {
  sampleRate: number;
  captureContent: boolean;
  langfuse: { publicKey: string; secretKey: string; baseUrl: string } | undefined;
};

const HINTS: Record<string, string> = {
  TRACE_SAMPLE_RATE: "A number from 0 to 1: 1 traces every request, 0.1 one in ten.",
  TRACE_CAPTURE_CONTENT: "true or false.",
  LANGFUSE_PUBLIC_KEY: "Langfuse → your project → Settings → API Keys.",
  LANGFUSE_SECRET_KEY: "Langfuse → your project → Settings → API Keys.",
  LANGFUSE_BASE_URL: "https://cloud.langfuse.com (EU) or https://us.cloud.langfuse.com (US), whichever your project is on.",
};

/** Reads the settings. `warn` hears about a setting that was ignored. */
export function parseTracingConfig(env: NodeJS.ProcessEnv, warn: (message: string) => void): TracingConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const name = String(issue.path[0]);
      return `- ${name} is invalid: ${issue.message}. ${HINTS[name] ?? ""}`.trimEnd();
    });
    throw new Error(`Tracing settings are wrong:\n${lines.join("\n")}\nFix them in .env in the repo root (every variable is listed in .env.example).`);
  }
  const e = parsed.data;

  let captureContent = e.TRACE_CAPTURE_CONTENT === "true";
  // The image runs with NODE_ENV=production: the capture is for a laptop, never a deploy.
  if (captureContent && e.NODE_ENV === "production") {
    warn("tracing: TRACE_CAPTURE_CONTENT is ignored with NODE_ENV=production. Ticket text never leaves a deployed service.");
    captureContent = false;
  }

  let langfuse: TracingConfig["langfuse"];
  if (e.LANGFUSE_PUBLIC_KEY && e.LANGFUSE_SECRET_KEY) {
    langfuse = { publicKey: e.LANGFUSE_PUBLIC_KEY, secretKey: e.LANGFUSE_SECRET_KEY, baseUrl: (e.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/+$/, "") };
  } else if (e.LANGFUSE_PUBLIC_KEY || e.LANGFUSE_SECRET_KEY) {
    // Said here; setupTracing() then says traces aren't being sent.
    warn(`tracing: ${e.LANGFUSE_PUBLIC_KEY ? "LANGFUSE_SECRET_KEY" : "LANGFUSE_PUBLIC_KEY"} is not set; Langfuse needs both keys.`);
  }

  return { sampleRate: e.TRACE_SAMPLE_RATE ?? 1, captureContent, langfuse };
}
