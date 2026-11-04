import request from "supertest";
import { describe, expect, it } from "vitest";
import { appMessage, buildOrderXml, readFixture, readSample } from "../fixtures/index.js";
import { createTestApp, DLQ_TOPIC, OUTPUT_TOPIC } from "../helpers/testApp.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("POST /messages: valid message", () => {
  it("returns 200 with exactly the expected output and publishes it once", async () => {
    const { app, broker } = createTestApp();
    const expected: unknown = JSON.parse(readSample("expected-output.json"));

    const res = await request(app)
      .post("/messages")
      .send(appMessage(readSample("order.xml")))
      .expect(200);

    expect(res.body).toEqual(expected);
    expect(broker.messages(OUTPUT_TOPIC).map((m) => m.json)).toEqual([expected]);
    expect(broker.messages(DLQ_TOPIC)).toEqual([]);
  });
});

/**
 * Each malformed input: the exact response, nothing on orders.transformed, and an app error record
 * on orders.failed, except transport-level failures (body not JSON / too large), which never
 * entered the pipeline (ADR-012).
 */
describe("POST /messages: malformed messages", () => {
  const cases: Array<{
    name: string;
    body: unknown;
    raw?: string;
    status: number;
    response: Record<string, unknown>;
    deadLettered: boolean;
  }> = [
    {
      name: "invalid Base64",
      body: { messageId: "m1", document: "not base64!" },
      status: 400,
      response: {
        error: "InvalidBase64",
        message: "Document is not a valid Base64 string.",
        messageId: "m1",
      },
      deadLettered: true,
    },
    {
      name: "invalid XML",
      body: { messageId: "m2", document: b64("<Order><ID>1</Order>") },
      status: 400,
      response: {
        error: "InvalidXml",
        message: "Message could not be parsed from XML to JSON.",
        messageId: "m2",
        details: [expect.stringMatching(/line 1, column \d+/)],
      },
      deadLettered: true,
    },
    {
      name: "a DOCTYPE (XXE / billion laughs)",
      body: { messageId: "m3", document: b64(readFixture("doctype-billion-laughs.xml")) },
      status: 400,
      response: {
        error: "InvalidXml",
        message: "Message could not be parsed from XML to JSON.",
        messageId: "m3",
        details: ["DOCTYPE declarations are not allowed."],
      },
      deadLettered: true,
    },
    {
      name: "a missing Order ID (the spec's example)",
      body: appMessage(buildOrderXml({ id: null }), "7a1e78c9"),
      status: 400,
      response: {
        error: "ValidationError",
        message: "Order ID is required.",
        messageId: "7a1e78c9",
      },
      deadLettered: true,
    },
    {
      name: "a missing messageId",
      body: { document: b64("<Order/>") },
      status: 400,
      response: { error: "ValidationError", message: "messageId is required.", messageId: null },
      deadLettered: true,
    },
    {
      name: "an empty document",
      body: { messageId: "m6", document: "" },
      status: 400,
      response: {
        error: "ValidationError",
        message: "document must not be empty.",
        messageId: "m6",
      },
      deadLettered: true,
    },
    {
      name: "a body that is not JSON",
      body: undefined,
      raw: "this is not json",
      status: 400,
      response: {
        error: "ValidationError",
        message: "Request body must be valid JSON.",
        messageId: null,
      },
      deadLettered: false,
    },
  ];

  it.each(cases)("$name -> $status", async ({ body, raw, status, response, deadLettered }) => {
    const { app, broker } = createTestApp();

    const res = await request(app)
      .post("/messages")
      .set("content-type", "application/json")
      .send(raw ?? (body as object))
      .expect(status);

    expect(res.body).toEqual(response);
    expect(broker.messages(OUTPUT_TOPIC)).toEqual([]);
    expect(broker.messages(DLQ_TOPIC)).toHaveLength(deadLettered ? 1 : 0);
    if (deadLettered) {
      expect(broker.messages(DLQ_TOPIC)[0]).toMatchObject({
        json: { error: { code: response.error }, originalMessage: body },
        attributes: { failureSource: "app" },
      });
    }
  });

  it("a body larger than MAX_BODY_BYTES -> 413, nothing published anywhere", async () => {
    const { app, broker } = createTestApp({ maxBodyBytes: 200 });
    await request(app)
      .post("/messages")
      .send(appMessage(readSample("order.xml")))
      .expect(413);
    expect(broker.messages(OUTPUT_TOPIC)).toEqual([]);
    expect(broker.messages(DLQ_TOPIC)).toEqual([]);
  });
});

describe("POST /messages: transient failures", () => {
  it("publish fails twice, the third in-app attempt succeeds -> 200", async () => {
    const { app, broker } = createTestApp();
    broker.failPublishes(OUTPUT_TOPIC, 2);

    await request(app)
      .post("/messages")
      .send(appMessage(readSample("order.xml")))
      .expect(200);
    expect(broker.messages(OUTPUT_TOPIC)).toHaveLength(1);
  });
});
