import { describe, expect, it } from "vitest";
import { InMemoryBroker } from "../../src/adapters/inMemoryBroker.js";
import { InMemoryIdempotencyStore } from "../../src/adapters/inMemoryIdempotencyStore.js";
import type { TransformedOrder } from "../../src/domain/types.js";
import { subscribeProcessor, type DeliveryReport } from "../../src/local/pushSubscription.js";
import { createProcessor } from "../../src/pipeline/processor.js";
import { appMessage, readSample } from "../fixtures/index.js";
import { captureLogger, fixedClock, noSleep } from "../helpers/index.js";

function setup(maxDeliveryAttempts = 3) {
  const clock = fixedClock();
  const broker = new InMemoryBroker(clock);
  const processMessage = createProcessor({
    publisher: broker,
    idempotencyStore: new InMemoryIdempotencyStore<TransformedOrder>({ ttlMs: 60_000, clock }),
    clock,
    logger: captureLogger().logger,
    outputTopic: "out",
    deadLetterTopic: "dlq",
    retry: { maxAttempts: 2, baseDelayMs: 1, sleep: noSleep },
  });
  const reports: DeliveryReport[] = [];
  subscribeProcessor(broker, processMessage, {
    topic: "in",
    deadLetterTopic: "dlq",
    maxDeliveryAttempts,
    onDelivery: (report) => reports.push(report),
  });
  return { broker, reports };
}

describe("subscribeProcessor (local push subscription, no HTTP)", () => {
  it("acks a valid message after publishing it", async () => {
    const { broker, reports } = setup();
    await broker.publish("in", appMessage(readSample("order.xml")));
    await broker.idle();
    expect(reports.map((r) => [r.deliveryAttempt, r.status, r.result.outcome])).toEqual([
      [1, 200, "published"],
    ]);
    expect(broker.messages("out")).toHaveLength(1);
  });

  it("acks a permanent error once (the app dead-letters it)", async () => {
    const { broker, reports } = setup();
    await broker.publish("in", { messageId: "m1", document: "not base64!" });
    await broker.idle();
    expect(reports.map((r) => r.status)).toEqual([200]);
    expect(broker.messages("dlq")[0]?.attributes.failureSource).toBe("app");
  });

  it("nacks transient failures until the platform dead-letters the original", async () => {
    const { broker, reports } = setup(3);
    broker.failPublishes("out", 99);
    await broker.publish("in", appMessage(readSample("order.xml")));
    await broker.idle();
    expect(reports.map((r) => r.status)).toEqual([500, 500, 500]);
    expect(broker.messages("dlq")[0]?.attributes).toMatchObject({
      CloudPubSubDeadLetterSourceDeliveryCount: "3",
    });
  });
});
