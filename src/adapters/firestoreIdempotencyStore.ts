import { createHash, randomUUID } from "node:crypto";
import { Timestamp, type DocumentReference, type Firestore } from "@google-cloud/firestore";
import { serverError } from "../domain/errors.js";
import { systemClock, type Clock } from "../ports/clock.js";
import type { ClaimResult, IdempotencyStore } from "../ports/idempotencyStore.js";

/** Shape of one idempotency document. */
interface IdempotencyDoc {
  key: string;
  status: "claimed" | "completed";
  token?: string;
  /** JSON string, not a map: Firestore does not preserve map key order, and the stored output is
   *  returned verbatim to duplicates. */
  result?: string;
  /** Read by the Firestore TTL policy, which deletes expired documents (with a delay of up to a day). */
  expiresAt: Timestamp;
}

export interface FirestoreIdempotencyStoreOptions {
  firestore: Firestore;
  collection: string;
  /** How long a completed key is remembered. */
  ttlMs: number;
  /** How long a claim lives without complete()/release(). Must exceed the worst-case processing time. */
  claimTtlMs?: number;
  /** Upper bound per operation, so a slow Firestore cannot eat the Pub/Sub ack deadline. */
  operationTimeoutMs?: number;
  clock?: Clock;
}

/**
 * Shared idempotency store for several instances. Every operation is a Firestore transaction, so
 * the read-check-write is atomic across instances (the contract in ports/idempotencyStore.ts).
 */
export class FirestoreIdempotencyStore<T> implements IdempotencyStore<T> {
  private readonly firestore: Firestore;
  private readonly collection: string;
  private readonly ttlMs: number;
  private readonly claimTtlMs: number;
  private readonly operationTimeoutMs: number;
  private readonly clock: Clock;

  constructor(options: FirestoreIdempotencyStoreOptions) {
    this.firestore = options.firestore;
    this.collection = options.collection;
    this.ttlMs = options.ttlMs;
    this.claimTtlMs = options.claimTtlMs ?? 60_000;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 5_000;
    this.clock = options.clock ?? systemClock;
  }

  tryClaim(key: string): Promise<ClaimResult<T>> {
    const ref = this.ref(key);
    return this.run("tryClaim", async () =>
      this.firestore.runTransaction(async (tx) => {
        const now = this.clock.now().getTime();
        const doc = (await tx.get(ref)).data() as IdempotencyDoc | undefined;
        // Check expiry ourselves: the TTL policy deletes expired documents only eventually.
        if (doc && doc.expiresAt.toMillis() > now) {
          return doc.status === "completed"
            ? { status: "completed" as const, result: JSON.parse(doc.result ?? "null") as T }
            : { status: "in-progress" as const };
        }
        const token = randomUUID();
        tx.set(ref, {
          key,
          status: "claimed",
          token,
          expiresAt: Timestamp.fromMillis(now + this.claimTtlMs),
        } satisfies IdempotencyDoc);
        return { status: "claimed" as const, token };
      }),
    );
  }

  complete(key: string, token: string, result: T): Promise<void> {
    const ref = this.ref(key);
    return this.run("complete", async () =>
      this.firestore.runTransaction(async (tx) => {
        if (!holds((await tx.get(ref)).data() as IdempotencyDoc | undefined, token)) return;
        tx.set(ref, {
          key,
          status: "completed",
          result: JSON.stringify(result),
          expiresAt: Timestamp.fromMillis(this.clock.now().getTime() + this.ttlMs),
        } satisfies IdempotencyDoc);
      }),
    );
  }

  release(key: string, token: string): Promise<void> {
    const ref = this.ref(key);
    return this.run("release", async () =>
      this.firestore.runTransaction(async (tx) => {
        if (holds((await tx.get(ref)).data() as IdempotencyDoc | undefined, token)) tx.delete(ref);
      }),
    );
  }

  /**
   * The document id is a hash of the key: messageIds come from partners and may contain "/"
   * (a path separator in Firestore) or exceed the 1500-byte id limit. The key itself is a field.
   */
  private ref(key: string): DocumentReference {
    const id = createHash("sha256").update(key, "utf8").digest("hex");
    return this.firestore.collection(this.collection).doc(id);
  }

  /** Bounds the wait (the transaction itself cannot be cancelled) and maps failures to transient. */
  private async run<R>(operation: string, work: () => Promise<R>): Promise<R> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`Firestore ${operation} timed out after ${this.operationTimeoutMs} ms`)),
        this.operationTimeoutMs,
      );
    });
    try {
      return await Promise.race([work(), timeout]);
    } catch (error) {
      throw serverError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The token alone decides ownership (same rule as the in-memory store). */
function holds(doc: IdempotencyDoc | undefined, token: string): boolean {
  return doc?.status === "claimed" && doc.token === token;
}
