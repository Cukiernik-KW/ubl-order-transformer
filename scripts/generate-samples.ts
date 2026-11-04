/**
 * Regenerates samples/ from samples/order.xml (the spec's sample XML), deterministically.
 * samples/expected-output.json is NOT generated: it is the spec's example output, written by hand,
 * so the golden tests compare the code against the spec rather than against itself.
 *
 *   npm run samples
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createAppMessage, wrapInPushEnvelope } from "../src/local/messages.js";

const dir = new URL("../samples/", import.meta.url);
const timestamp = "2026-07-27T12:00:00Z";
const orderXml = readFileSync(new URL("order.xml", dir), "utf8");

function write(name: string, value: unknown): void {
  writeFileSync(new URL(name, dir), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`samples/${name}`);
}

const valid = createAppMessage(orderXml, { messageId: "7a1e78c9", timestamp });

write("message.valid.json", valid);
write("message.invalid-base64.json", {
  messageId: "invalid-base64-1",
  timestamp,
  document: "This is not Base64!",
});
write(
  "message.invalid-xml.json",
  createAppMessage(orderXml.replace("</Order>", ""), { messageId: "invalid-xml-1", timestamp }),
);
write(
  "message.missing-order-id.json",
  createAppMessage(orderXml.replace("<cbc:ID>12347</cbc:ID>", ""), {
    messageId: "missing-order-id-1",
    timestamp,
  }),
);
write(
  "push-envelope.valid.json",
  wrapInPushEnvelope(valid, {
    pubsubMessageId: "1234567890",
    publishTime: "2026-07-27T12:00:01Z",
    subscription: "projects/your-project/subscriptions/orders.ubl.received.transformer",
  }),
);
