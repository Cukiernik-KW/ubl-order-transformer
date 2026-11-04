/**
 * Sends a sample to a running service (local or Cloud Run) and prints the response.
 *
 *   npm run publish:local -- samples/message.valid.json               # POST /messages
 *   npm run publish:local -- samples/message.valid.json --push        # wrapped as Pub/Sub push -> /pubsub/push
 *   npm run publish:local -- samples/push-envelope.valid.json         # envelopes always go to /pubsub/push
 *   npm run publish:local -- samples/message.valid.json \
 *     --url https://<service>.run.app --token "$(gcloud auth print-identity-token)"
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isPushEnvelope, wrapInPushEnvelope } from "../src/local/messages.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    push: { type: "boolean", default: false },
    token: { type: "string" },
  },
});

const [file] = positionals;
if (!file) {
  console.error(
    "Usage: npm run publish:local -- <file.json> [--push] [--url <base url>] [--token <id token>]",
  );
  process.exit(1);
}

const payload: unknown = JSON.parse(readFileSync(file, "utf8"));
const asPush = values.push || isPushEnvelope(payload);
const body = asPush && !isPushEnvelope(payload) ? wrapInPushEnvelope(payload) : payload;
const url = new URL(asPush ? "/pubsub/push" : "/messages", values.url);

const headers: Record<string, string> = { "content-type": "application/json" };
if (values.token) headers.authorization = `Bearer ${values.token}`;

const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
const text = await response.text();
console.log(`POST ${url.pathname} -> ${response.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
