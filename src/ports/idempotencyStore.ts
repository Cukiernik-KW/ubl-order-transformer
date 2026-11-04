/** `token` identifies this claim: only its holder can complete or release it (fencing). */
export type ClaimResult<T> =
  | { status: "claimed"; token: string }
  | { status: "in-progress" }
  | { status: "completed"; result: T };

/**
 * Deduplicates by key (the application messageId).
 * Async on purpose: the production implementation (Firestore) is remote.
 *
 * Contract for implementations (checked by test/contract/idempotencyStore.contract.ts):
 * - tryClaim is atomic across ALL instances: Cloud Run routes by load, not by key.
 * - Claims expire, so a crashed instance cannot block a key forever.
 * - complete/release with a stale token are no-ops: a slow instance whose claim expired and was
 *   taken over must not overwrite or delete the new holder's claim.
 */
export interface IdempotencyStore<T> {
  /** Atomically reserves the key, or reports that it is in progress / already completed. */
  tryClaim(key: string): Promise<ClaimResult<T>>;
  /** Marks the key as done. Call only AFTER the output was published. */
  complete(key: string, token: string, result: T): Promise<void>;
  /** Drops a claim so a later delivery can retry (used on any failure). */
  release(key: string, token: string): Promise<void>;
}
