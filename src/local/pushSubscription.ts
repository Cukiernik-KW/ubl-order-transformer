import type { InMemoryBroker, BrokerMessage } from "../adapters/inMemoryBroker.js";
import { unwrapPushEnvelope } from "../http/pubsubEnvelope.js";
import { toPushResponse } from "../http/responses.js";
import type { Processor, ProcessResult } from "../pipeline/processor.js";
import { wrapInPushEnvelope } from "./messages.js";

// The status codes Pub/Sub push treats as an ack; anything else is a nack.
const ACK_STATUSES = new Set([102, 200, 201, 202, 204]);

export interface DeliveryReport {
  message: BrokerMessage;
  deliveryAttempt: number;
  status: number;
  result: ProcessResult;
}

/**
 * Local stand-in for a Pub/Sub push subscription, without HTTP: each delivery goes through the same
 * envelope decoding and the same status mapping as POST /pubsub/push, so ack/nack decisions are
 * identical to production. Used by `npm run simulate`.
 */
export function subscribeProcessor(
  broker: InMemoryBroker,
  processMessage: Processor,
  options: {
    topic: string;
    deadLetterTopic: string;
    maxDeliveryAttempts: number;
    onDelivery?: (report: DeliveryReport) => void;
  },
): void {
  broker.subscribe(
    options.topic,
    async (message, attempt) => {
      const envelope = wrapInPushEnvelope(message.json, {
        pubsubMessageId: message.id,
        deliveryAttempt: attempt,
        publishTime: message.publishedAt.toISOString(),
      });
      const { appMessage, pubsubMessageId, deliveryAttempt } = unwrapPushEnvelope(envelope);
      const result = await processMessage(appMessage, {
        source: "push",
        pubsubMessageId,
        deliveryAttempt,
      });
      const { status } = toPushResponse(result);
      options.onDelivery?.({ message, deliveryAttempt: attempt, status, result });
      return ACK_STATUSES.has(status) ? "ack" : "nack";
    },
    { maxDeliveryAttempts: options.maxDeliveryAttempts, deadLetterTopic: options.deadLetterTopic },
  );
}
