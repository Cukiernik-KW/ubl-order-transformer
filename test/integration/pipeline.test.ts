import { describe, expect, it } from "vitest";
import type { Publisher } from "../../src/ports/publisher.js";
import { appMessage, buildOrderXml, readFixture } from "../fixtures/index.js";
import { connectPushSubscription, INPUT_TOPIC } from "../helpers/pushBridge.js";
import { createTestApp, DLQ_TOPIC, OUTPUT_TOPIC } from "../helpers/testApp.js";

/**
 * Full loop, as on GCP: partner publishes to the input topic -> push subscription -> real HTTP app
 * -> output / DLQ topics. Only the Pub/Sub transport is in memory; none of our code is mocked.
 */
const sample = () => appMessage(readFixture("order.sample.xml"));
const expectedOutput: unknown = JSON.parse(readFixture("expected-output.sample.json"));

/** Counts publish attempts to the output topic, and optionally fails them for one messageId. */
function countingPublisher(options: { alwaysFailFor?: string } = {}) {
  const counter = { outputAttempts: 0 };
  const wrap = (broker: Publisher): Publisher => ({
    publish: (topic, json, attributes) => {
      if (topic === OUTPUT_TOPIC) {
        counter.outputAttempts++;
        if (options.alwaysFailFor && attributes?.messageId === options.alwaysFailFor) {
          return Promise.reject(new Error("Pub/Sub UNAVAILABLE"));
        }
      }
      return broker.publish(topic, json, attributes);
    },
  });
  return { counter, wrap };
}

describe("pipeline through the in-memory Pub/Sub push subscription", () => {
  it("a valid message is delivered once and published with exactly the expected output", async () => {
    const { app, broker } = createTestApp();
    const { statuses } = connectPushSubscription(broker, app);

    await broker.publish(INPUT_TOPIC, sample());
    await broker.idle();

    expect(statuses).toEqual([200]);
    expect(broker.messages(OUTPUT_TOPIC).map((m) => m.json)).toEqual([expectedOutput]);
    expect(broker.messages(OUTPUT_TOPIC)[0]?.attributes).toEqual({
      messageId: "7a1e78c9",
      orderId: "12347",
    });
    expect(broker.messages(DLQ_TOPIC)).toEqual([]);
  });

  it("a poison message is delivered exactly once: acked and dead-lettered by the app", async () => {
    const { app, broker } = createTestApp();
    const { statuses } = connectPushSubscription(broker, app);

    await broker.publish(INPUT_TOPIC, appMessage("<Order><ID>1</Order>", "poison-1"));
    await broker.idle();

    expect(statuses).toEqual([200]); // no redelivery loop
    expect(broker.messages(OUTPUT_TOPIC)).toEqual([]);
    expect(broker.messages(DLQ_TOPIC)).toHaveLength(1);
    expect(broker.messages(DLQ_TOPIC)[0]).toMatchObject({
      json: { messageId: "poison-1", error: { code: "InvalidXml" } },
      attributes: { failureSource: "app", errorCode: "InvalidXml", messageId: "poison-1" },
    });
  });

  it("a short outage is absorbed by redelivery: first delivery fails, second succeeds", async () => {
    const { app, broker, logLines } = createTestApp();
    const { statuses } = connectPushSubscription(broker, app);
    broker.failPublishes(OUTPUT_TOPIC, 3); // all 3 in-app attempts of the first delivery

    await broker.publish(INPUT_TOPIC, sample());
    await broker.idle();

    expect(statuses).toEqual([500, 200]);
    expect(broker.messages(OUTPUT_TOPIC)).toHaveLength(1);
    expect(broker.messages(DLQ_TOPIC)).toEqual([]);
    expect(
      logLines().find((l) => l.message === "Message processed" && l.outcome === "published"),
    ).toMatchObject({ deliveryAttempt: 2 });
  });

  it("a long outage: 5 deliveries x 3 in-app attempts, then the platform dead-letters the ORIGINAL", async () => {
    const { counter, wrap } = countingPublisher({ alwaysFailFor: "7a1e78c9" });
    const { app, broker } = createTestApp({ publisher: wrap });
    const { statuses } = connectPushSubscription(broker, app, { maxDeliveryAttempts: 5 });

    const original = sample();
    await broker.publish(INPUT_TOPIC, original);
    await broker.idle();

    expect(statuses).toEqual([500, 500, 500, 500, 500]);
    expect(counter.outputAttempts).toBe(15); // two retry layers multiply
    expect(broker.messages(OUTPUT_TOPIC)).toEqual([]);

    const deadLettered = broker.messages(DLQ_TOPIC);
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0]?.json).toEqual(original); // raw original, not an app error record
    expect(deadLettered[0]?.attributes).toMatchObject({
      CloudPubSubDeadLetterSourceDeliveryCount: "5",
    });
    expect(deadLettered[0]?.attributes.failureSource).toBeUndefined();
  });

  it("a partner re-publishing the same message produces one output", async () => {
    const { app, broker } = createTestApp();
    const { statuses } = connectPushSubscription(broker, app);

    await broker.publish(INPUT_TOPIC, sample());
    await broker.idle();
    await broker.publish(INPUT_TOPIC, sample()); // new Pub/Sub id, same application messageId
    await broker.idle();

    expect(statuses).toEqual([200, 200]);
    expect(broker.messages(OUTPUT_TOPIC)).toHaveLength(1);
  });

  it("invariant: every message ends in exactly one of orders.transformed or orders.failed", async () => {
    const { wrap } = countingPublisher({ alwaysFailFor: "outage" });
    const { app, broker } = createTestApp({ publisher: wrap });
    connectPushSubscription(broker, app, { maxDeliveryAttempts: 3 });

    const inputs = [
      appMessage(buildOrderXml({ id: "A-1" }), "valid-1"),
      appMessage(buildOrderXml({ id: "A-2" }), "valid-2"),
      { messageId: "bad-base64", document: "not base64!" },
      appMessage("<Order><ID>1</Order>", "bad-xml"),
      appMessage(buildOrderXml({ id: null }), "no-order-id"),
      appMessage(buildOrderXml({ lines: [] }), "no-lines"),
      appMessage(buildOrderXml({ id: "A-3" }), "outage"),
    ];
    for (const input of inputs) await broker.publish(INPUT_TOPIC, input);
    await broker.idle();

    const messageIdOf = (json: unknown) => (json as { messageId: string }).messageId;
    const transformed = broker.messages(OUTPUT_TOPIC).map((m) => messageIdOf(m.json));
    const failed = broker.messages(DLQ_TOPIC).map((m) => messageIdOf(m.json));

    expect([...transformed, ...failed].sort()).toEqual(inputs.map((i) => i.messageId).sort());
    expect(transformed.sort()).toEqual(["valid-1", "valid-2"]);
  });
});
