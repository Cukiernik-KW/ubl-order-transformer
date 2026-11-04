/**
 * End-to-end test against the deployed stack on GCP (infra/): publishes to the real input topic and
 * pulls from the ops subscriptions on the output topics. Skipped unless E2E_GCP=1 and
 * GOOGLE_CLOUD_PROJECT are set. Auth: your ADC (gcloud auth application-default login).
 *
 *   E2E_GCP=1 GOOGLE_CLOUD_PROJECT=<project> npm run test:e2e
 */
import { randomUUID } from "node:crypto";
import { PubSub, v1 } from "@google-cloud/pubsub";
import { afterAll, describe, expect, it } from "vitest";
import { readSample } from "../fixtures/index.js";

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const enabled = process.env.E2E_GCP === "1" && Boolean(projectId);

const INPUT_TOPIC = "orders.ubl.received";
const TRANSFORMED_SUB = "orders.transformed.ops";
const FAILED_SUB = "orders.failed.ops";
const TIMEOUT_MS = 90_000; // includes a possible Cloud Run cold start

interface Received {
  attributes: Record<string, string>;
  json: Record<string, unknown>;
}

describe.skipIf(!enabled)("GCP end-to-end (deployed stack)", () => {
  const pubsub = new PubSub({ projectId });
  const subscriber = new v1.SubscriberClient({ projectId });
  afterAll(async () => {
    await Promise.all([pubsub.close(), subscriber.close()]);
  });

  /** Unique per run, so runs never see each other's messages. */
  const newId = (kind: string) => `e2e-${kind}-${randomUUID()}`;

  function messageFrom(sample: string, messageId: string): Record<string, unknown> {
    return { ...(JSON.parse(readSample(sample)) as Record<string, unknown>), messageId };
  }

  async function publish(message: Record<string, unknown>): Promise<void> {
    await pubsub.topic(INPUT_TOPIC).publishMessage({ json: message });
  }

  /**
   * Pulls until `count` messages with this messageId attribute have arrived or the deadline passes.
   * Only our own messages are acked; anything else is handed back at once (ack deadline 0), so
   * parallel runs or the demo are not disturbed. Pull blocks server-side, so no sleeps are needed.
   */
  async function collect(
    subscriptionName: string,
    messageId: string,
    { count, untilMs }: { count: number; untilMs: number },
  ): Promise<Received[]> {
    const subscription = subscriber.subscriptionPath(projectId!, subscriptionName);
    const found: Received[] = [];
    const deadline = Date.now() + untilMs;
    while (found.length < count && Date.now() < deadline) {
      const response = await pullOnce(subscription, deadline);
      const ours: string[] = [];
      const others: string[] = [];
      for (const { ackId, message } of response.receivedMessages ?? []) {
        if (message?.attributes?.messageId === messageId) {
          ours.push(ackId!);
          found.push({
            attributes: { ...message.attributes },
            json: JSON.parse(Buffer.from(message.data as Uint8Array).toString("utf8")) as Record<
              string,
              unknown
            >,
          });
        } else {
          others.push(ackId!);
        }
      }
      if (ours.length > 0) await subscriber.acknowledge({ subscription, ackIds: ours });
      if (others.length > 0) {
        await subscriber.modifyAckDeadline({ subscription, ackIds: others, ackDeadlineSeconds: 0 });
      }
    }
    return found;
  }

  /** One blocking pull; an empty subscription ends in DEADLINE_EXCEEDED, which means "nothing yet". */
  async function pullOnce(subscription: string, deadline: number) {
    try {
      const [response] = await subscriber.pull(
        { subscription, maxMessages: 50 },
        { timeout: Math.max(1_000, Math.min(20_000, deadline - Date.now())) },
      );
      return response;
    } catch (error) {
      if ((error as { code?: number }).code === 4) return { receivedMessages: [] }; // DEADLINE_EXCEEDED
      throw error;
    }
  }

  it(
    "transforms a valid message and publishes it to orders.transformed",
    async () => {
      const messageId = newId("valid");
      await publish(messageFrom("message.valid.json", messageId));

      const [output] = await collect(TRANSFORMED_SUB, messageId, { count: 1, untilMs: TIMEOUT_MS });
      expect(output).toBeDefined();
      // Identical to the spec's example output, except the ids and the time of this run.
      const expected = JSON.parse(readSample("expected-output.json")) as Record<string, unknown>;
      const { transformedAt, ...rest } = output!.json;
      expect(rest).toEqual({ ...expected, messageId, transformedAt: undefined });
      expect(transformedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(output!.attributes).toEqual({ messageId, orderId: "12347" });
    },
    TIMEOUT_MS + 10_000,
  );

  it(
    "dead-letters an invalid message to orders.failed with the error and the original message",
    async () => {
      const messageId = newId("invalid");
      const original = messageFrom("message.missing-order-id.json", messageId);
      await publish(original);

      const [record] = await collect(FAILED_SUB, messageId, { count: 1, untilMs: TIMEOUT_MS });
      expect(record).toBeDefined();
      expect(record!.attributes).toEqual({
        failureSource: "app",
        errorCode: "ValidationError",
        messageId,
      });
      expect(record!.json).toMatchObject({
        messageId,
        error: { code: "ValidationError", message: "Order ID is required." },
        originalMessage: original,
      });
    },
    TIMEOUT_MS + 10_000,
  );

  it(
    "publishes 5 concurrent copies of one message exactly once (shared Firestore idempotency)",
    async () => {
      const messageId = newId("duplicate");
      const message = messageFrom("message.valid.json", messageId);
      await Promise.all(Array.from({ length: 5 }, () => publish(message)));

      const first = await collect(TRANSFORMED_SUB, messageId, { count: 1, untilMs: TIMEOUT_MS });
      expect(first).toHaveLength(1);
      // Absence can only be shown within a window: wait for any second output for 20 s more.
      const extra = await collect(TRANSFORMED_SUB, messageId, { count: 1, untilMs: 20_000 });
      expect(extra).toHaveLength(0);
    },
    TIMEOUT_MS + 40_000,
  );
});
