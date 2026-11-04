/**
 * Encodes any UBL XML file into an application message (or a push envelope) on stdout.
 *
 *   npm run encode -- my-order.xml
 *   npm run encode -- my-order.xml --message-id abc-1 --push > envelope.json
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createAppMessage, wrapInPushEnvelope } from "../src/local/messages.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "message-id": { type: "string" },
    push: { type: "boolean", default: false },
  },
});

const [file] = positionals;
if (!file) {
  console.error("Usage: npm run encode -- <file.xml> [--message-id <id>] [--push]");
  process.exit(1);
}

const message = createAppMessage(readFileSync(file, "utf8"), {
  messageId: values["message-id"] ?? crypto.randomUUID(),
});
const output = values.push ? wrapInPushEnvelope(message) : message;
console.log(JSON.stringify(output, null, 2));
