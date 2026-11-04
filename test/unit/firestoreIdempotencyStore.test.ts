import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { FirestoreIdempotencyStore } from "../../src/adapters/firestoreIdempotencyStore.js";
import { AppError } from "../../src/domain/errors.js";

/** Only what the adapter touches: collection().doc() and runTransaction(). */
function stubFirestore(runTransaction: () => Promise<unknown>): Firestore {
  return {
    collection: () => ({ doc: () => ({}) }),
    runTransaction,
  } as unknown as Firestore;
}

function store(runTransaction: () => Promise<unknown>) {
  return new FirestoreIdempotencyStore<unknown>({
    firestore: stubFirestore(runTransaction),
    collection: "idempotency",
    ttlMs: 1000,
    operationTimeoutMs: 20,
  });
}

// Failure paths without the emulator; the behaviour is covered by the contract tests on the emulator.
describe("FirestoreIdempotencyStore failures", () => {
  it("maps a Firestore error to a transient ServerError (so push nacks and Pub/Sub redelivers)", async () => {
    const failing = store(() => Promise.reject(new Error("14 UNAVAILABLE")));
    const error = await failing.tryClaim("m1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "ServerError", permanent: false });
    expect((error as AppError).cause).toMatchObject({ message: "14 UNAVAILABLE" });
  });

  it("gives up after operationTimeoutMs, so a slow Firestore cannot eat the ack deadline", async () => {
    const hanging = store(() => new Promise(() => {}));
    const error = await hanging.complete("m1", "token", {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ServerError", permanent: false });
    expect((error as AppError).cause).toMatchObject({
      message: "Firestore complete timed out after 20 ms",
    });
  });

  it("maps release() failures the same way", async () => {
    const failing = store(() => Promise.reject(new Error("boom")));
    await expect(failing.release("m1", "token")).rejects.toMatchObject({ code: "ServerError" });
  });
});
