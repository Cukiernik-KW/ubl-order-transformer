import { decodeBase64Strict } from "../domain/base64.js";
import { AppError, serverError } from "../domain/errors.js";
import { extractMessageId, parseAppMessage } from "../domain/message.js";
import { formatTimestamp } from "../domain/time.js";
import type { TransformedOrder } from "../domain/types.js";
import { mapUblOrder } from "../domain/ublMapper.js";
import { decodeUtf8, parseXml } from "../domain/xml.js";
import type { Logger } from "../observability/logger.js";
import type { Clock } from "../ports/clock.js";
import type { IdempotencyStore } from "../ports/idempotencyStore.js";
import type { MessageAttributes, Publisher } from "../ports/publisher.js";
import { withRetry, type RetryOptions } from "./retry.js";

export interface ProcessorDeps {
  publisher: Publisher;
  idempotencyStore: IdempotencyStore<TransformedOrder>;
  clock: Clock;
  logger: Logger;
  outputTopic: string;
  deadLetterTopic: string;
  retry: Omit<RetryOptions, "onRetry">;
}

export interface ProcessContext {
  source: "http" | "push";
  pubsubMessageId?: string;
  deliveryAttempt?: number;
}

/** Every message ends in exactly one of these outcomes; the HTTP layer maps each to a status code. */
export type ProcessResult =
  | { outcome: "published"; messageId: string; output: TransformedOrder }
  | { outcome: "duplicate"; messageId: string; output: TransformedOrder }
  | { outcome: "in-progress"; messageId: string }
  /** Permanent error: bad input. `deadLettered` = an error record reached the DLQ topic. */
  | { outcome: "rejected"; messageId: string | null; error: AppError; deadLettered: boolean }
  /** Transient error: retrying later may succeed. Nothing is dead-lettered by the app. */
  | { outcome: "failed"; messageId: string | null; error: AppError };

/** Shape of the records this service publishes to the DLQ topic (failureSource=app). */
export interface DeadLetterRecord {
  messageId: string | null;
  failedAt: string;
  error: { code: string; message: string; details: readonly string[] };
  originalMessage: unknown;
}

export type Processor = (raw: unknown, ctx: ProcessContext) => Promise<ProcessResult>;

export function createProcessor(deps: ProcessorDeps): Processor {
  const { publisher, idempotencyStore, clock, outputTopic, deadLetterTopic } = deps;

  return async function processMessage(raw, ctx) {
    // Monotonic clock for durations; `clock` is business time and may be fixed in tests.
    const startedAt = performance.now();
    const messageId = extractMessageId(raw);
    const log = deps.logger.child({
      messageId,
      pubsubMessageId: ctx.pubsubMessageId,
      deliveryAttempt: ctx.deliveryAttempt,
      source: ctx.source,
    });
    const facts: { orderId?: string; documentBytes?: number } = {};

    const retryOptions: RetryOptions = {
      ...deps.retry,
      onRetry: ({ attempt, delayMs, error }) =>
        log.warn({ attempt, delayMs, err: error }, "Publish failed, retrying"),
    };

    async function deadLetter(error: AppError): Promise<boolean> {
      const record: DeadLetterRecord = {
        messageId,
        failedAt: formatTimestamp(clock.now()),
        error: { code: error.code, message: error.message, details: error.details },
        originalMessage: raw,
      };
      const attributes: MessageAttributes = { failureSource: "app", errorCode: error.code };
      if (messageId) attributes.messageId = messageId;
      try {
        await withRetry(() => publisher.publish(deadLetterTopic, record, attributes), retryOptions);
        return true;
      } catch (dlqError) {
        log.error({ err: dlqError }, "Could not publish to the dead-letter topic");
        return false;
      }
    }

    /**
     * Best effort: if the store is down, a throw here would hide the original error and skip the
     * summary log. The claim then simply expires (claim TTL) and a redelivery can take it over.
     */
    async function releaseClaim(claim: { key: string; token: string }): Promise<void> {
      try {
        await idempotencyStore.release(claim.key, claim.token);
      } catch (releaseError) {
        log.warn({ err: releaseError }, "Could not release the idempotency claim");
      }
    }

    async function run(): Promise<ProcessResult> {
      let claim: { key: string; token: string } | undefined;
      try {
        // Step 1: validate.
        const message = parseAppMessage(raw);

        // Idempotency: claim right after validation, so duplicates are never parsed again.
        const claimResult = await idempotencyStore.tryClaim(message.messageId);
        if (claimResult.status === "completed") {
          return { outcome: "duplicate", messageId: message.messageId, output: claimResult.result };
        }
        if (claimResult.status === "in-progress") {
          return { outcome: "in-progress", messageId: message.messageId };
        }
        claim = { key: message.messageId, token: claimResult.token };

        // Steps 2-4: decode, parse, transform (pure domain functions).
        const xmlBytes = decodeBase64Strict(message.document);
        facts.documentBytes = xmlBytes.length;
        const output = mapUblOrder(parseXml(decodeUtf8(xmlBytes)), {
          messageId: message.messageId,
          transformedAt: clock.now(),
        });
        facts.orderId = output.order.orderId;

        // Step 5: publish (transient failures retried), then mark completed.
        await withRetry(
          () =>
            publisher.publish(outputTopic, output, {
              messageId: message.messageId,
              orderId: output.order.orderId,
            }),
          retryOptions,
        );
        // Crash window: if the process dies between publish and complete, a redelivery publishes
        // again. Output is at-least-once, so downstream consumers must be idempotent.
        await idempotencyStore.complete(claim.key, claim.token, output);
        return { outcome: "published", messageId: message.messageId, output };
      } catch (caught) {
        // Any failure frees the key: a redelivery (transient) or a corrected resend (permanent) can retry.
        if (claim) await releaseClaim(claim);

        const error = caught instanceof AppError ? caught : serverError(caught);
        if (!error.permanent) {
          return { outcome: "failed", messageId, error };
        }
        return { outcome: "rejected", messageId, error, deadLettered: await deadLetter(error) };
      }
    }

    const result = await run();
    logOutcome(log, result, {
      ...facts,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return result;
  };
}

/** One summary line per message: the basis for a log-based latency metric and for tracing by messageId. */
function logOutcome(
  log: Logger,
  result: ProcessResult,
  fields: { durationMs: number; orderId?: string; documentBytes?: number },
): void {
  const base = { outcome: result.outcome, ...fields };
  switch (result.outcome) {
    case "published":
    case "duplicate":
      log.info(base, "Message processed");
      return;
    case "in-progress":
      log.warn(base, "Duplicate message is still being processed");
      return;
    case "rejected": {
      const errorFields = {
        errorCode: result.error.code,
        errorDetails: result.error.details,
        deadLettered: result.deadLettered,
      };
      // Bad input is the partner's problem (WARNING); losing it is ours (ERROR).
      if (result.deadLettered) log.warn({ ...base, ...errorFields }, "Message rejected");
      else log.error({ ...base, ...errorFields }, "Message rejected and NOT dead-lettered");
      return;
    }
    case "failed":
      log.error(
        { ...base, errorCode: result.error.code, err: result.error.cause ?? result.error },
        "Message processing failed (transient)",
      );
      return;
  }
}
