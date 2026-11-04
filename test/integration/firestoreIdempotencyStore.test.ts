import { createHash, randomUUID } from "node:crypto";
import { Firestore, Timestamp } from "@google-cloud/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { FirestoreIdempotencyStore } from "../../src/adapters/firestoreIdempotencyStore.js";
import { InMemoryBroker } from "../../src/adapters/inMemoryBroker.js";
import type { TransformedOrder } from "../../src/domain/types.js";
import { createProcessor } from "../../src/pipeline/processor.js";
import {
  CONTRACT_CLAIM_TTL_MS,
  CONTRACT_TTL_MS,
  describeIdempotencyStoreContract,
} from "../contract/idempotencyStore.contract.js";
import { appMessage, readSample } from "../fixtures/index.js";
import { captureLogger, fixedClock, noSleep } from "../helpers/index.js";

// Runs against the Firestore emulator (npm run test:firestore, and in CI); skipped without it.
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT_ID = "demo-ubl-order-transformer"; // "demo-" projects never touch real GCP

describe.skipIf(!emulator)("FirestoreIdempotencyStore (emulator)", () => {
  const clients: Firestore[] = [];
  const client = () => {
    const firestore = new Firestore({ projectId: PROJECT_ID });
    clients.push(firestore);
    return firestore;
  };
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.terminate()));
  });

  // Every test gets its own collection, so tests never see each other's documents.
  describeIdempotencyStoreContract("FirestoreIdempotencyStore", (clock) => {
    const collection = `idempotency-${randomUUID()}`;
    const create = () =>
      new FirestoreIdempotencyStore<unknown>({
        firestore: client(),
        collection,
        ttlMs: CONTRACT_TTL_MS,
        claimTtlMs: CONTRACT_CLAIM_TTL_MS,
        clock,
      });
    return { store: create(), newInstance: create };
  });

  it("stores the document under sha256(key), with the key and a Timestamp for the TTL policy", async () => {
    const firestore = client();
    const collection = `idempotency-${randomUUID()}`;
    const store = new FirestoreIdempotencyStore<unknown>({
      firestore,
      collection,
      ttlMs: CONTRACT_TTL_MS,
      clock: fixedClock("2026-01-01T00:00:00Z"),
    });
    const key = "partner/order#1";
    const claim = await store.tryClaim(key);
    if (claim.status !== "claimed") throw new Error("expected a claim");
    await store.complete(key, claim.token, { orderId: "1" });

    const id = createHash("sha256").update(key).digest("hex");
    const doc = (await firestore.collection(collection).doc(id).get()).data();
    expect(doc).toEqual({
      key,
      status: "completed",
      result: '{"orderId":"1"}',
      expiresAt: Timestamp.fromDate(new Date("2026-01-01T01:00:00Z")),
    });
  });

  it("two instances receiving the same message at the same time publish it exactly once", async () => {
    const collection = `idempotency-${randomUUID()}`;
    const clock = fixedClock("2026-07-27T12:01:00Z");
    const broker = new InMemoryBroker(clock); // shared output topic, as in real Pub/Sub
    const instance = () =>
      createProcessor({
        publisher: broker,
        idempotencyStore: new FirestoreIdempotencyStore<TransformedOrder>({
          firestore: client(),
          collection,
          ttlMs: CONTRACT_TTL_MS,
          clock,
        }),
        clock,
        logger: captureLogger().logger,
        outputTopic: "orders.transformed",
        deadLetterTopic: "orders.failed",
        retry: { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep },
      });
    const instances = [instance(), instance(), instance()];
    const message = appMessage(readSample("order.xml"));

    const results = await Promise.all(
      instances.map((processMessage) => processMessage(message, { source: "push" })),
    );
    // Exactly one publishes. The others see in-progress or, if their transaction was serialized
    // after the winner's complete(), duplicate: both are correct, the timing decides.
    const outcomes = results.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === "published")).toHaveLength(1);
    for (const other of outcomes.filter((o) => o !== "published")) {
      expect(["in-progress", "duplicate"]).toContain(other);
    }
    expect(broker.messages("orders.transformed")).toHaveLength(1);

    // A later redelivery to any instance is a duplicate with the stored output.
    const redelivery = await instances[2]!(message, { source: "push" });
    expect(redelivery.outcome).toBe("duplicate");
    expect(broker.messages("orders.transformed")).toHaveLength(1);
  });
});
