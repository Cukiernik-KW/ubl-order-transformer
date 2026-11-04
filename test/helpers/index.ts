import { Writable } from "node:stream";
import { createLogger, type Logger } from "../../src/observability/logger.js";
import type { Clock } from "../../src/ports/clock.js";

/** A clock that stays where you put it. */
export function fixedClock(iso = "2026-07-27T12:01:00Z"): Clock & { set(iso: string): void } {
  let current = new Date(iso);
  return {
    now: () => new Date(current),
    set: (next: string) => {
      current = new Date(next);
    },
  };
}

/** A real pino logger whose JSON lines are captured for assertions. */
export function captureLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      raw.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ level: "debug", destination });
  return {
    logger,
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export const noSleep = () => Promise.resolve();
