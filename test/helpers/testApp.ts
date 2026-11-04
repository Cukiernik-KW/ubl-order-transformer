import { InMemoryBroker } from "../../src/adapters/inMemoryBroker.js";
import { InMemoryIdempotencyStore } from "../../src/adapters/inMemoryIdempotencyStore.js";
import { createApp } from "../../src/app.js";
import type { TransformedOrder } from "../../src/domain/types.js";
import { createProcessor, type Processor } from "../../src/pipeline/processor.js";
import type { Publisher } from "../../src/ports/publisher.js";
import { captureLogger, fixedClock, noSleep } from "./index.js";

export const OUTPUT_TOPIC = "orders.transformed";
export const DLQ_TOPIC = "orders.failed";

/** The real app wired with in-memory adapters, a fixed clock and instant retries. */
export function createTestApp(
  options: {
    publisher?: (broker: InMemoryBroker) => Publisher;
    processMessage?: Processor;
    maxBodyBytes?: number;
    maxAttempts?: number;
    debug?: boolean;
  } = {},
) {
  const clock = fixedClock("2026-07-27T12:01:00Z");
  const broker = new InMemoryBroker(clock);
  const store = new InMemoryIdempotencyStore<TransformedOrder>({ ttlMs: 3_600_000, clock });
  const { logger, lines } = captureLogger();
  const processMessage =
    options.processMessage ??
    createProcessor({
      publisher: options.publisher ? options.publisher(broker) : broker,
      idempotencyStore: store,
      clock,
      logger,
      outputTopic: OUTPUT_TOPIC,
      deadLetterTopic: DLQ_TOPIC,
      retry: { maxAttempts: options.maxAttempts ?? 3, baseDelayMs: 1, sleep: noSleep },
    });
  const app = createApp({
    processMessage,
    logger,
    maxBodyBytes: options.maxBodyBytes ?? 1_048_576,
    debugBroker: options.debug ? broker : undefined,
  });
  return { app, broker, clock, store, logLines: lines, processMessage };
}
