/**
 * Local simulation of the whole Pub/Sub flow in one process, no GCP needed:
 * partner publishes to orders.ubl.received -> push subscription -> processor -> orders.transformed / orders.failed.
 *
 *   npm run simulate                                    # all samples/message.*.json
 *   npm run simulate -- samples/message.valid.json
 *   npm run simulate -- --fail-publishes 3              # a short outage: first delivery fails, redelivery succeeds
 *   npm run simulate -- --fail-publishes 99 --max-delivery-attempts 3   # long outage: platform dead-letters
 *   npm run simulate -- --verbose                       # also print the service's JSON logs
 */
import { readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { InMemoryBroker } from "../src/adapters/inMemoryBroker.js";
import { InMemoryIdempotencyStore } from "../src/adapters/inMemoryIdempotencyStore.js";
import type { TransformedOrder } from "../src/domain/types.js";
import { unwrapPushEnvelope } from "../src/http/pubsubEnvelope.js";
import { isPushEnvelope } from "../src/local/messages.js";
import { subscribeProcessor } from "../src/local/pushSubscription.js";
import { createLogger } from "../src/observability/logger.js";
import { createProcessor } from "../src/pipeline/processor.js";
import { systemClock } from "../src/ports/clock.js";

const INPUT_TOPIC = "orders.ubl.received";
const OUTPUT_TOPIC = "orders.transformed";
const DLQ_TOPIC = "orders.failed";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "fail-publishes": { type: "string", default: "0" },
    "max-delivery-attempts": { type: "string", default: "5" },
    verbose: { type: "boolean", default: false },
  },
});

const files =
  positionals.length > 0
    ? positionals
    : readdirSync("samples")
        .filter((name) => name.startsWith("message.") && name.endsWith(".json"))
        .map((name) => `samples/${name}`);

/** Accepts an app message file, or a push envelope file (unwrapped to the app message). */
function loadMessage(file: string): unknown {
  const json: unknown = JSON.parse(readFileSync(file, "utf8"));
  return isPushEnvelope(json) ? unwrapPushEnvelope(json).appMessage : json;
}

const broker = new InMemoryBroker();
const logger = createLogger({ level: values.verbose ? "info" : "silent" });
const processMessage = createProcessor({
  publisher: broker,
  idempotencyStore: new InMemoryIdempotencyStore<TransformedOrder>({ ttlMs: 3_600_000 }),
  clock: systemClock,
  logger,
  outputTopic: OUTPUT_TOPIC,
  deadLetterTopic: DLQ_TOPIC,
  retry: { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100 },
});

subscribeProcessor(broker, processMessage, {
  topic: INPUT_TOPIC,
  deadLetterTopic: DLQ_TOPIC,
  maxDeliveryAttempts: Number(values["max-delivery-attempts"]),
  onDelivery: ({ message, deliveryAttempt, status, result }) => {
    const verdict = status >= 200 && status < 300 ? "ack " : "nack";
    const detail = "error" in result ? `${result.outcome}: ${result.error.code}` : result.outcome;
    console.log(
      `   delivery attempt ${deliveryAttempt} (msg #${message.id}) -> ${status} ${verdict} (${detail})`,
    );
  },
});

const failures = Number(values["fail-publishes"]);
if (failures > 0) {
  broker.failPublishes(OUTPUT_TOPIC, failures);
  console.log(`(simulating ${failures} failed publish attempt(s) to ${OUTPUT_TOPIC})`);
}

for (const file of files) {
  const message = loadMessage(file);
  const id = await broker.publish(INPUT_TOPIC, message);
  console.log(`-> publish ${INPUT_TOPIC} #${id}  (${file})`);
  await broker.idle();
}

for (const topic of [OUTPUT_TOPIC, DLQ_TOPIC]) {
  const messages = broker.messages(topic);
  console.log(`\n=== ${topic} (${messages.length}) ===`);
  for (const message of messages) {
    console.log(`attributes: ${JSON.stringify(message.attributes)}`);
    console.log(JSON.stringify(message.json, null, 2));
  }
}
