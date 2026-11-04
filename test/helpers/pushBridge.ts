import type { Express } from "express";
import request from "supertest";
import type { InMemoryBroker } from "../../src/adapters/inMemoryBroker.js";
import { pushEnvelope } from "./index.js";
import { DLQ_TOPIC } from "./testApp.js";

export const INPUT_TOPIC = "orders.ubl.received";

// The status codes Pub/Sub push treats as an ack; anything else is a nack.
const ACK_STATUSES = new Set([102, 200, 201, 202, 204]);

/**
 * Connects the in-memory broker to the real HTTP app, like a Pub/Sub push subscription:
 * wrap the message in a push envelope, POST it, ack on 2xx, otherwise redeliver,
 * and dead-letter the original after maxDeliveryAttempts.
 */
export function connectPushSubscription(
  broker: InMemoryBroker,
  app: Express,
  options: { maxDeliveryAttempts?: number } = {},
): { statuses: number[] } {
  const statuses: number[] = [];
  broker.subscribe(
    INPUT_TOPIC,
    async (message, deliveryAttempt) => {
      const res = await request(app)
        .post("/pubsub/push")
        .send(pushEnvelope(message.json, { pubsubMessageId: message.id, deliveryAttempt }));
      statuses.push(res.status);
      return ACK_STATUSES.has(res.status) ? "ack" : "nack";
    },
    { maxDeliveryAttempts: options.maxDeliveryAttempts ?? 5, deadLetterTopic: DLQ_TOPIC },
  );
  return { statuses };
}
