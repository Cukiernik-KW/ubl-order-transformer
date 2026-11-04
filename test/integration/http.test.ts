import request from "supertest";
import { describe, expect, it } from "vitest";
import { appMessage, buildOrderXml, readSample } from "../fixtures/index.js";
import { pushEnvelope } from "../helpers/index.js";
import { createTestApp, DLQ_TOPIC, OUTPUT_TOPIC } from "../helpers/testApp.js";

const sample = () => appMessage(readSample("order.xml"));

describe("GET /health", () => {
  it("answers 200", async () => {
    const { app } = createTestApp();
    await request(app).get("/health").expect(200, { status: "ok" });
  });
});

describe("POST /messages: outcome -> status mapping", () => {
  it("published -> 200 with the transformed order", async () => {
    const { app, broker } = createTestApp();
    const res = await request(app).post("/messages").send(sample()).expect(200);
    expect(res.body).toMatchObject({ messageId: "7a1e78c9", order: { orderId: "12347" } });
    expect(broker.messages(OUTPUT_TOPIC)).toHaveLength(1);
  });

  it("duplicate -> 200 with the same stored order, published once", async () => {
    const { app, broker } = createTestApp();
    const first = await request(app).post("/messages").send(sample());
    const second = await request(app).post("/messages").send(sample()).expect(200);
    expect(second.body).toEqual(first.body);
    expect(broker.messages(OUTPUT_TOPIC)).toHaveLength(1);
  });

  it("in-progress -> 409 DuplicateInProgress", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { app } = createTestApp({
      publisher: (broker) => ({
        publish: async (...args) => {
          await gate;
          return broker.publish(...args);
        },
      }),
    });

    const first = request(app)
      .post("/messages")
      .send(sample())
      .then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the first request claim the key
    const second = await request(app).post("/messages").send(sample());
    open();

    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: "DuplicateInProgress",
      message: "A message with this messageId is already being processed.",
      messageId: "7a1e78c9",
    });
    expect((await first).status).toBe(200);
  });

  it("rejected -> 400 with the spec's exact body (no details for a single issue)", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/messages")
      .send(appMessage(buildOrderXml({ id: null })))
      .expect(400, {
        error: "ValidationError",
        message: "Order ID is required.",
        messageId: "7a1e78c9",
      });
  });

  it("rejected with several issues -> 400 with details", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/messages")
      .send(appMessage(buildOrderXml({ id: null, accountId: null })))
      .expect(400);
    expect((res.body as { details: string[] }).details).toEqual([
      "Order ID is required.",
      "Buyer account ID (BuyerCustomerParty/SupplierAssignedAccountID) is required.",
    ]);
  });

  it("rejected, even when the DLQ is down -> still 400 (the input IS invalid)", async () => {
    const { app, broker } = createTestApp();
    broker.failPublishes(DLQ_TOPIC, 3);
    await request(app).post("/messages").send({ messageId: "m1", document: "@@" }).expect(400);
  });

  it("failed (transient) -> 500 ServerError", async () => {
    const { app, broker } = createTestApp();
    broker.failPublishes(OUTPUT_TOPIC, 3);
    await request(app).post("/messages").send(sample()).expect(500, {
      error: "ServerError",
      message: "An unexpected error occurred.",
      messageId: "7a1e78c9",
    });
  });
});

describe("POST /pubsub/push: outcome -> status mapping (ack = 2xx, nack = anything else)", () => {
  it("published -> 200 ack", async () => {
    const { app, broker } = createTestApp();
    await request(app).post("/pubsub/push").send(pushEnvelope(sample())).expect(200);
    expect(broker.messages(OUTPUT_TOPIC)).toHaveLength(1);
  });

  it("in-progress -> 409 nack, so Pub/Sub redelivers later", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { app } = createTestApp({
      publisher: (broker) => ({
        publish: async (...args) => {
          await gate;
          return broker.publish(...args);
        },
      }),
    });
    const first = request(app)
      .post("/pubsub/push")
      .send(pushEnvelope(sample()))
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await request(app).post("/pubsub/push").send(pushEnvelope(sample()));
    open();
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });

  it("rejected and dead-lettered -> 200 ack, so Pub/Sub does not redeliver a poison message", async () => {
    const { app, broker } = createTestApp();
    const res = await request(app)
      .post("/pubsub/push")
      .send(pushEnvelope({ messageId: "m1", document: "not base64!" }))
      .expect(200);
    expect(res.body).toMatchObject({ error: "InvalidBase64", messageId: "m1" });
    expect(broker.messages(DLQ_TOPIC)).toHaveLength(1);
  });

  it("rejected but NOT dead-lettered -> 500 nack, so the message is not lost", async () => {
    const { app, broker } = createTestApp();
    broker.failPublishes(DLQ_TOPIC, 3);
    await request(app)
      .post("/pubsub/push")
      .send(pushEnvelope({ messageId: "m1", document: "not base64!" }))
      .expect(500);
  });

  it("failed (transient) -> 500 nack", async () => {
    const { app, broker } = createTestApp();
    broker.failPublishes(OUTPUT_TOPIC, 3);
    await request(app).post("/pubsub/push").send(pushEnvelope(sample())).expect(500);
    expect(broker.messages(DLQ_TOPIC)).toEqual([]);
  });

  it("data that is not JSON -> rejected, dead-lettered with the raw text, 200 ack", async () => {
    const { app, broker } = createTestApp();
    const res = await request(app)
      .post("/pubsub/push")
      .send(pushEnvelope("<Order>raw XML instead of JSON</Order>"))
      .expect(200);
    expect(res.body).toEqual({
      error: "ValidationError",
      message: "Message must be a JSON object.",
      messageId: null,
    });
    expect(broker.messages(DLQ_TOPIC)[0]?.json).toMatchObject({
      originalMessage: "<Order>raw XML instead of JSON</Order>",
    });
  });

  it("an invalid envelope -> 400, nothing published (real Pub/Sub never sends one)", async () => {
    const { app, broker } = createTestApp();
    await request(app).post("/pubsub/push").send(sample()).expect(400, {
      error: "ValidationError",
      message: "Invalid Pub/Sub push envelope.",
      messageId: null,
    });
    expect(broker.messages(DLQ_TOPIC)).toEqual([]);
  });

  it("logs the Pub/Sub messageId and deliveryAttempt for correlation", async () => {
    const { app, logLines } = createTestApp();
    await request(app)
      .post("/pubsub/push")
      .send(pushEnvelope(sample(), { pubsubMessageId: "ps-77", deliveryAttempt: 4 }));
    expect(logLines().find((line) => line.message === "Message processed")).toMatchObject({
      messageId: "7a1e78c9",
      pubsubMessageId: "ps-77",
      deliveryAttempt: 4,
      source: "push",
    });
  });
});

describe("HTTP edge cases", () => {
  it("a body that is not JSON -> 400 ValidationError", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/messages")
      .set("content-type", "application/json")
      .send("{not json")
      .expect(400, {
        error: "ValidationError",
        message: "Request body must be valid JSON.",
        messageId: null,
      });
  });

  it("parses JSON even without a JSON Content-Type (curl -d default)", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/messages")
      .set("content-type", "application/x-www-form-urlencoded")
      .send(JSON.stringify(sample()))
      .expect(200);
  });

  it("an empty body -> 400 'Message is required.'", async () => {
    const { app } = createTestApp();
    await request(app).post("/messages").expect(400, {
      error: "ValidationError",
      message: "Message is required.",
      messageId: null,
    });
  });

  it("a body over MAX_BODY_BYTES -> 413", async () => {
    const { app } = createTestApp({ maxBodyBytes: 100 });
    const res = await request(app).post("/messages").send(sample()).expect(413);
    expect(res.body).toMatchObject({
      error: "ValidationError",
      message: "Request body exceeds the limit of 100 bytes.",
    });
  });

  it("an unknown route -> 404", async () => {
    const { app } = createTestApp();
    await request(app).get("/nope").expect(404);
  });

  it("an unexpected error -> 500 ServerError without stack trace or internal message", async () => {
    const { app, logLines } = createTestApp({
      processMessage: () => Promise.reject(new Error("db password is hunter2")),
    });
    const res = await request(app).post("/messages").send(sample()).expect(500);

    expect(res.body).toEqual({
      error: "ServerError",
      message: "An unexpected error occurred.",
      messageId: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|at .*\.ts/);
    // ...but the details are in the log.
    expect(JSON.stringify(logLines())).toContain("hunter2");
  });

  it("does not advertise the framework", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("GET /debug/topics/:name (in-memory mode only)", () => {
  it("lists what was published to a topic", async () => {
    const { app } = createTestApp({ debug: true });
    await request(app).post("/messages").send(sample());
    const res = await request(app).get(`/debug/topics/${OUTPUT_TOPIC}`).expect(200);
    expect(res.body).toMatchObject({ topic: OUTPUT_TOPIC, count: 1 });
  });

  it("does not exist without the in-memory broker (PUBLISHER=pubsub)", async () => {
    const { app } = createTestApp();
    await request(app).get(`/debug/topics/${OUTPUT_TOPIC}`).expect(404);
  });
});
