import { InMemoryBroker } from "./adapters/inMemoryBroker.js";
import { InMemoryIdempotencyStore } from "./adapters/inMemoryIdempotencyStore.js";
import { PubSubPublisher } from "./adapters/pubsubPublisher.js";
import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import type { TransformedOrder } from "./domain/types.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { createProcessor } from "./pipeline/processor.js";
import { systemClock } from "./ports/clock.js";
import type { Publisher } from "./ports/publisher.js";

// Cloud Run sends SIGTERM and kills the container ~10 s later; finish before that.
const SHUTDOWN_TIMEOUT_MS = 9_000;

function createPublisher(config: Config): {
  publisher: Publisher;
  close: () => Promise<void>;
  debugBroker?: InMemoryBroker;
} {
  if (config.PUBLISHER === "pubsub") {
    const publisher = new PubSubPublisher({
      projectId: config.GOOGLE_CLOUD_PROJECT,
      publishTimeoutMs: config.PUBLISH_TIMEOUT_MS,
    });
    return { publisher, close: () => publisher.close() };
  }
  const broker = new InMemoryBroker();
  return { publisher: broker, close: () => Promise.resolve(), debugBroker: broker };
}

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    // Fail fast with a readable message; the logger isn't configured yet.
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  }
}

function main(): void {
  const config = readConfig();
  const logger: Logger = createLogger({ level: config.LOG_LEVEL });
  const { publisher, close: closePublisher, debugBroker } = createPublisher(config);

  const processMessage = createProcessor({
    publisher,
    idempotencyStore: new InMemoryIdempotencyStore<TransformedOrder>({
      ttlMs: config.IDEMPOTENCY_TTL_SECONDS * 1000,
    }),
    clock: systemClock,
    logger,
    outputTopic: config.OUTPUT_TOPIC,
    deadLetterTopic: config.DLQ_TOPIC,
    retry: {
      maxAttempts: config.PUBLISH_MAX_ATTEMPTS,
      baseDelayMs: config.PUBLISH_RETRY_BASE_MS,
      maxDelayMs: config.PUBLISH_RETRY_MAX_MS,
    },
  });

  const app = createApp({
    processMessage,
    logger,
    maxBodyBytes: config.MAX_BODY_BYTES,
    debugBroker,
  });
  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, publisher: config.PUBLISHER, outputTopic: config.OUTPUT_TOPIC },
      "Server listening",
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down: draining in-flight requests");

    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    // Stop accepting connections; the callback runs once in-flight requests have finished.
    server.close((error) => {
      closePublisher()
        .then(() => {
          logger.info("Shutdown complete");
          process.exit(error ? 1 : 0);
        })
        .catch((closeError: unknown) => {
          logger.error({ err: closeError }, "Failed to flush publisher on shutdown");
          process.exit(1);
        });
    });
    // Keep-alive sockets with no request in flight would otherwise hold server.close() open.
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection");
    process.exit(1);
  });
}

main();
