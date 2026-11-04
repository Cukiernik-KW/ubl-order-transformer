import { pino, stdTimeFunctions, type DestinationStream, type Logger } from "pino";

export type { Logger };

// Cloud Logging reads `severity` (not pino's numeric `level`) and `message` from JSON on stdout.
const SEVERITY: Record<string, string> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

export function createLogger(
  options: { level?: string; destination?: DestinationStream } = {},
): Logger {
  return pino(
    {
      level: options.level ?? "info",
      messageKey: "message",
      // No pid/hostname: Cloud Run attaches resource labels (service, revision, instance) itself.
      base: undefined,
      timestamp: stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ severity: SEVERITY[label] ?? "DEFAULT" }),
      },
    },
    options.destination,
  );
}
