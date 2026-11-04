import { z } from "zod";

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const ConfigSchema = z.object({
  PORT: positiveInt(8080),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  /** memory = in-process broker (local runs, tests); pubsub = Google Cloud Pub/Sub via ADC. */
  PUBLISHER: z.enum(["memory", "pubsub"]).default("memory"),
  /** Optional: on Cloud Run the client library detects the project from the metadata server. */
  GOOGLE_CLOUD_PROJECT: z.string().min(1).optional(),
  OUTPUT_TOPIC: z.string().min(1).default("orders.transformed"),
  DLQ_TOPIC: z.string().min(1).default("orders.failed"),
  PUBLISH_MAX_ATTEMPTS: positiveInt(3),
  PUBLISH_RETRY_BASE_MS: positiveInt(200),
  PUBLISH_RETRY_MAX_MS: positiveInt(5_000),
  PUBLISH_TIMEOUT_MS: positiveInt(5_000),
  IDEMPOTENCY_TTL_SECONDS: positiveInt(86_400),
  MAX_BODY_BYTES: positiveInt(1_048_576),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Reads and validates configuration once, at startup (fail fast): a typo in an env var stops the
 * container immediately with every problem listed, instead of failing on the first message.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty strings count as "not set", so `FOO=` falls back to the default.
  const defined = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = ConfigSchema.safeParse(defined);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return result.data;
}
