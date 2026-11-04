import { describe, expect, it, vi } from "vitest";
import { InMemoryBroker, type DeliveryResult } from "../../src/adapters/inMemoryBroker.js";
import { AppError } from "../../src/domain/errors.js";
import { fixedClock } from "../helpers/index.js";

describe("InMemoryBroker as a publisher", () => {
  it("stores published messages per topic with ids and attributes", async () => {
    const broker = new InMemoryBroker(fixedClock());
    await expect(broker.publish("a", { n: 1 }, { k: "v" })).resolves.toBe("1");
    await broker.publish("b", { n: 2 });
    expect(broker.messages("a")).toEqual([
      {
        id: "1",
        topic: "a",
        json: { n: 1 },
        attributes: { k: "v" },
        publishedAt: new Date("2026-07-27T12:01:00Z"),
      },
    ]);
    expect(broker.messages("b")).toHaveLength(1);
    expect(broker.messages("unknown")).toEqual([]);
  });

  it("stores a copy, so the caller can't mutate a sent message", async () => {
    const broker = new InMemoryBroker();
    const payload = { n: 1 };
    await broker.publish("a", payload);
    payload.n = 2;
    expect(broker.messages("a")[0]?.json).toEqual({ n: 1 });
  });

  it("injects transient publish failures", async () => {
    const broker = new InMemoryBroker();
    broker.failPublishes("a", 1);
    const failure = broker.publish("a", {});
    await expect(failure).rejects.toBeInstanceOf(AppError);
    await expect(failure).rejects.toMatchObject({ code: "ServerError", permanent: false });
    await expect(broker.publish("a", {})).resolves.toBeDefined();
    expect(broker.messages("a")).toHaveLength(1);
  });
});

describe("InMemoryBroker push subscription", () => {
  it("delivers asynchronously, after publish() has returned", async () => {
    const broker = new InMemoryBroker();
    const handler = vi.fn(() => Promise.resolve<DeliveryResult>("ack"));
    broker.subscribe("in", handler, { maxDeliveryAttempts: 5, deadLetterTopic: "dlq" });

    await broker.publish("in", { n: 1 });
    expect(handler).not.toHaveBeenCalled();

    await broker.idle();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ json: { n: 1 } }), 1);
  });

  it("redelivers a nack with an increasing deliveryAttempt", async () => {
    const broker = new InMemoryBroker();
    const attempts: number[] = [];
    broker.subscribe(
      "in",
      (_message, attempt) => {
        attempts.push(attempt);
        return Promise.resolve(attempt < 3 ? "nack" : "ack");
      },
      { maxDeliveryAttempts: 5, deadLetterTopic: "dlq" },
    );
    await broker.publish("in", {});
    await broker.idle();
    expect(attempts).toEqual([1, 2, 3]);
    expect(broker.messages("dlq")).toEqual([]);
  });

  it("treats a throwing handler as a nack", async () => {
    const broker = new InMemoryBroker();
    let calls = 0;
    broker.subscribe(
      "in",
      () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ack");
      },
      { maxDeliveryAttempts: 5, deadLetterTopic: "dlq" },
    );
    await broker.publish("in", {});
    await broker.idle();
    expect(calls).toBe(2);
  });

  it("dead-letters the original message after maxDeliveryAttempts", async () => {
    const broker = new InMemoryBroker();
    const handler = vi.fn(() => Promise.resolve<DeliveryResult>("nack"));
    broker.subscribe("in", handler, { maxDeliveryAttempts: 3, deadLetterTopic: "dlq" });

    await broker.publish("in", { order: 1 }, { messageId: "m1" });
    await broker.idle();

    expect(handler).toHaveBeenCalledTimes(3);
    expect(broker.messages("dlq")).toHaveLength(1);
    expect(broker.messages("dlq")[0]).toMatchObject({
      json: { order: 1 },
      attributes: {
        messageId: "m1",
        CloudPubSubDeadLetterSourceSubscription: "in.sub",
        CloudPubSubDeadLetterSourceDeliveryCount: "3",
      },
    });
  });

  it("surfaces delivery infrastructure errors from idle() instead of crashing the process", async () => {
    const broker = new InMemoryBroker();
    broker.subscribe("in", () => Promise.resolve("nack"), {
      maxDeliveryAttempts: 1,
      deadLetterTopic: "dlq",
    });
    broker.failPublishes("dlq", 1);
    await broker.publish("in", {});
    await expect(broker.idle()).rejects.toBeInstanceOf(AggregateError);
  });
});
