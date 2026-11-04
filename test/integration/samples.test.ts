import request from "supertest";
import { describe, expect, it } from "vitest";
import { readSample } from "../fixtures/index.js";
import { createTestApp, DLQ_TOPIC, OUTPUT_TOPIC } from "../helpers/testApp.js";

/** The files in samples/ behave exactly as the README says. */
const sample = (name: string): object => JSON.parse(readSample(name)) as object;

describe("samples/", () => {
  it("message.valid.json carries samples/order.xml, Base64-encoded", () => {
    const { document } = sample("message.valid.json") as { document: string };
    expect(Buffer.from(document, "base64").toString("utf8")).toBe(readSample("order.xml"));
  });

  it("message.valid.json -> 200 with samples/expected-output.json (the spec's output)", async () => {
    const { app, broker } = createTestApp();
    const res = await request(app).post("/messages").send(sample("message.valid.json")).expect(200);
    expect(res.body).toEqual(sample("expected-output.json"));
    expect(broker.messages(OUTPUT_TOPIC)).toHaveLength(1);
  });

  it("push-envelope.valid.json -> /pubsub/push 200 with the same output", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/pubsub/push")
      .send(sample("push-envelope.valid.json"))
      .expect(200);
    expect(res.body).toEqual(sample("expected-output.json"));
  });

  it.each([
    ["message.invalid-base64.json", "InvalidBase64", "Document is not a valid Base64 string."],
    ["message.invalid-xml.json", "InvalidXml", "Message could not be parsed from XML to JSON."],
    ["message.missing-order-id.json", "ValidationError", "Order ID is required."],
  ])("%s -> 400 %s, dead-lettered", async (file, error, message) => {
    const { app, broker } = createTestApp();
    const body = sample(file) as { messageId: string };
    const res = await request(app).post("/messages").send(body).expect(400);
    expect(res.body).toMatchObject({ error, message, messageId: body.messageId });
    expect(broker.messages(OUTPUT_TOPIC)).toEqual([]);
    expect(broker.messages(DLQ_TOPIC)).toHaveLength(1);
  });
});
