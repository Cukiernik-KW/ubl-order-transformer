import { describe, expect, it } from "vitest";
import { InMemoryBroker } from "../../src/adapters/inMemoryBroker.js";
import { InMemoryIdempotencyStore } from "../../src/adapters/inMemoryIdempotencyStore.js";
import type { TransformedOrder } from "../../src/domain/types.js";
import { createProcessor, type ProcessContext } from "../../src/pipeline/processor.js";
import type { Publisher } from "../../src/ports/publisher.js";
import { appMessage, buildOrderXml, readSample } from "../fixtures/index.js";
import { captureLogger, fixedClock, noSleep } from "../helpers/index.js";

const OUT = "orders.transformed";
const DLQ = "orders.failed";
const http: ProcessContext = { source: "http" };

function setup(options: { publisher?: (broker: InMemoryBroker) => Publisher } = {}) {
  const clock = fixedClock("2026-07-27T12:01:00Z");
  const broker = new InMemoryBroker(clock);
  const store = new InMemoryIdempotencyStore<TransformedOrder>({ ttlMs: 3_600_000, clock });
  const { logger, lines } = captureLogger();
  const processMessage = createProcessor({
    publisher: options.publisher ? options.publisher(broker) : broker,
    idempotencyStore: store,
    clock,
    logger,
    outputTopic: OUT,
    deadLetterTopic: DLQ,
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep },
  });
  return { broker, clock, store, lines, processMessage };
}

const sample = () => appMessage(readSample("order.xml"));

describe("processor: happy path", () => {
  it("publishes the transformed order with messageId and orderId attributes", async () => {
    const { broker, processMessage } = setup();

    const result = await processMessage(sample(), http);

    expect(result).toMatchObject({ outcome: "published", messageId: "7a1e78c9" });
    const published = broker.messages(OUT);
    expect(published).toHaveLength(1);
    expect(published[0]?.attributes).toEqual({ messageId: "7a1e78c9", orderId: "12347" });
    expect(published[0]?.json).toMatchObject({
      messageId: "7a1e78c9",
      transformedAt: "2026-07-27T12:01:00Z",
      order: { orderId: "12347", lines: [{ lineId: 1 }, { lineId: 2 }] },
    });
    expect(broker.messages(DLQ)).toEqual([]);
  });
});

describe("processor: permanent errors (rejected + DLQ)", () => {
  it("dead-letters an error record with the original message", async () => {
    const { broker, processMessage } = setup();
    const raw = { messageId: "m-bad", document: "not base64 !!!" };

    const result = await processMessage(raw, http);

    expect(result).toMatchObject({
      outcome: "rejected",
      messageId: "m-bad",
      deadLettered: true,
      error: { code: "InvalidBase64" },
    });
    expect(broker.messages(OUT)).toEqual([]);
    expect(broker.messages(DLQ)).toHaveLength(1);
    expect(broker.messages(DLQ)[0]).toMatchObject({
      json: {
        messageId: "m-bad",
        failedAt: "2026-07-27T12:01:00Z",
        error: {
          code: "InvalidBase64",
          message: "Document is not a valid Base64 string.",
          details: [],
        },
        originalMessage: raw,
      },
      attributes: { failureSource: "app", errorCode: "InvalidBase64", messageId: "m-bad" },
    });
  });

  it("reports every validation issue for a missing Order ID", async () => {
    const { broker, processMessage } = setup();
    const result = await processMessage(appMessage(buildOrderXml({ id: null }), "m2"), http);

    expect(result).toMatchObject({
      outcome: "rejected",
      error: { code: "ValidationError", message: "Order ID is required." },
    });
    expect(broker.messages(DLQ)[0]?.json).toMatchObject({
      error: { code: "ValidationError", details: ["Order ID is required."] },
    });
  });

  it("dead-letters a message without messageId (messageId: null, no attribute)", async () => {
    const { broker, processMessage } = setup();
    const result = await processMessage({ document: "PE9yZGVyLz4=" }, http);

    expect(result).toMatchObject({ outcome: "rejected", messageId: null });
    expect(broker.messages(DLQ)[0]?.json).toMatchObject({ messageId: null });
    expect(broker.messages(DLQ)[0]?.attributes).toEqual({
      failureSource: "app",
      errorCode: "ValidationError",
    });
  });

  it("does not block the messageId: a corrected resend is processed", async () => {
    const { broker, processMessage } = setup();
    await processMessage(appMessage(buildOrderXml({ id: null }), "m3"), http);
    const resend = await processMessage(appMessage(buildOrderXml(), "m3"), http);

    expect(resend.outcome).toBe("published");
    expect(broker.messages(OUT)).toHaveLength(1);
  });

  it("reports deadLettered: false (and logs ERROR) when the DLQ publish fails", async () => {
    const { broker, lines, processMessage } = setup();
    broker.failPublishes(DLQ, 3); // every retry attempt fails

    const result = await processMessage({ messageId: "m4", document: "@@@@" }, http);

    expect(result).toMatchObject({ outcome: "rejected", deadLettered: false });
    expect(broker.messages(DLQ)).toEqual([]);
    expect(lines().some((l) => l.severity === "ERROR" && l.deadLettered === false)).toBe(true);
  });
});

describe("processor: transient errors (retry, then failed)", () => {
  it("retries a failing publish and succeeds", async () => {
    const { broker, lines, processMessage } = setup();
    broker.failPublishes(OUT, 2);

    const result = await processMessage(sample(), http);

    expect(result.outcome).toBe("published");
    expect(broker.messages(OUT)).toHaveLength(1);
    expect(lines().filter((l) => l.message === "Publish failed, retrying")).toHaveLength(2);
  });

  it("returns failed after all attempts, without dead-lettering, and frees the messageId", async () => {
    const { broker, processMessage } = setup();
    broker.failPublishes(OUT, 3);

    const first = await processMessage(sample(), http);
    expect(first).toMatchObject({
      outcome: "failed",
      error: { code: "ServerError", permanent: false, message: "An unexpected error occurred." },
    });
    expect(broker.messages(OUT)).toEqual([]);
    expect(broker.messages(DLQ)).toEqual([]);

    // A redelivery can now succeed.
    const redelivery = await processMessage(sample(), http);
    expect(redelivery.outcome).toBe("published");
  });

  it("wraps an unexpected (non-AppError) failure as a transient ServerError", async () => {
    const boom = new Error("socket hang up");
    const { processMessage } = setup({
      publisher: () => ({ publish: () => Promise.reject(boom) }),
    });

    const result = await processMessage(sample(), http);
    expect(result).toMatchObject({
      outcome: "failed",
      error: { code: "ServerError", cause: boom },
    });
  });
});

describe("processor: idempotency", () => {
  it("publishes a duplicate only once and returns the stored output", async () => {
    const { broker, clock, processMessage } = setup();
    const first = await processMessage(sample(), http);
    clock.set("2026-07-27T13:00:00Z");
    const second = await processMessage(sample(), http);

    expect(second.outcome).toBe("duplicate");
    if (first.outcome !== "published" || second.outcome !== "duplicate")
      throw new Error("unreachable");
    expect(second.output).toEqual(first.output); // same transformedAt: the stored result
    expect(broker.messages(OUT)).toHaveLength(1);
  });

  it("reports in-progress for a concurrent duplicate", async () => {
    let releasePublish!: () => void;
    const gate = new Promise<void>((resolve) => (releasePublish = resolve));
    const { broker, processMessage } = setup({
      publisher: (b) => ({
        publish: async (...args) => {
          await gate;
          return b.publish(...args);
        },
      }),
    });

    const first = processMessage(sample(), http);
    await new Promise((resolve) => setImmediate(resolve)); // let `first` reach the publish
    const second = await processMessage(sample(), http);
    releasePublish();

    expect(second).toEqual({ outcome: "in-progress", messageId: "7a1e78c9" });
    expect((await first).outcome).toBe("published");
    expect(broker.messages(OUT)).toHaveLength(1);
  });
});

describe("processor: observability", () => {
  it("logs one summary line with correlation fields and durationMs", async () => {
    const { lines, processMessage } = setup();
    await processMessage(sample(), {
      source: "push",
      pubsubMessageId: "ps-42",
      deliveryAttempt: 2,
    });

    const summary = lines().filter((l) => l.message === "Message processed");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      severity: "INFO",
      outcome: "published",
      messageId: "7a1e78c9",
      pubsubMessageId: "ps-42",
      deliveryAttempt: 2,
      source: "push",
      orderId: "12347",
      documentBytes: expect.any(Number) as number,
      durationMs: expect.any(Number) as number,
    });
  });

  it("never logs the document itself", async () => {
    const { lines, processMessage } = setup();
    const message = sample();
    await processMessage(message, http);
    await processMessage({ ...message, messageId: "other", document: "@@@" }, http);

    const all = JSON.stringify(lines());
    expect(all).not.toContain(message.document);
    expect(all).not.toContain("SellersItemIdentification");
  });
});
