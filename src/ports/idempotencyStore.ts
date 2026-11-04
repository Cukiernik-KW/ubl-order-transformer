export type ClaimResult<T> =
  { status: "claimed" } | { status: "in-progress" } | { status: "completed"; result: T };

/**
 * Deduplicates by key (the application messageId).
 * Async on purpose: production implementations (Firestore, Redis) are remote.
 */
export interface IdempotencyStore<T> {
  /** Atomically reserves the key, or reports that it is in progress / already completed. */
  tryClaim(key: string): Promise<ClaimResult<T>>;
  /** Marks the key as done. Call only AFTER the output was published. */
  complete(key: string, result: T): Promise<void>;
  /** Drops a claim so a later delivery can retry (used on any failure). */
  release(key: string): Promise<void>;
}
