import { randomUUID } from "node:crypto";
import type { ClaimResult, IdempotencyStore } from "../ports/idempotencyStore.js";
import { systemClock, type Clock } from "../ports/clock.js";

type Entry<T> =
  | { state: "in-progress"; token: string; expiresAt: number }
  | { state: "completed"; result: T; expiresAt: number };

export interface InMemoryIdempotencyStoreOptions {
  /** How long a completed key is remembered. */
  ttlMs: number;
  /** How long a claim lives without complete()/release(), so a hung request can't block a key forever. */
  claimTtlMs?: number;
  clock?: Clock;
}

/**
 * Per-instance store, lost on restart: for local runs, tests and a single instance. Deployments
 * with more instances use FirestoreIdempotencyStore. tryClaim has no await between the read and
 * the write, so on single-threaded Node the check-and-set is atomic.
 */
export class InMemoryIdempotencyStore<T> implements IdempotencyStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly claimTtlMs: number;
  private readonly clock: Clock;
  private lastSweep = 0;

  constructor(options: InMemoryIdempotencyStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.claimTtlMs = options.claimTtlMs ?? 60_000;
    this.clock = options.clock ?? systemClock;
  }

  tryClaim(key: string): Promise<ClaimResult<T>> {
    const now = this.clock.now().getTime();
    this.sweepExpired(now);

    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) {
      return Promise.resolve(
        entry.state === "completed"
          ? { status: "completed", result: entry.result }
          : { status: "in-progress" },
      );
    }
    const token = randomUUID();
    this.entries.set(key, { state: "in-progress", token, expiresAt: now + this.claimTtlMs });
    return Promise.resolve({ status: "claimed", token });
  }

  complete(key: string, token: string, result: T): Promise<void> {
    if (this.holds(key, token)) {
      const now = this.clock.now().getTime();
      this.entries.set(key, { state: "completed", result, expiresAt: now + this.ttlMs });
    }
    return Promise.resolve();
  }

  release(key: string, token: string): Promise<void> {
    if (this.holds(key, token)) this.entries.delete(key);
    return Promise.resolve();
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The token alone decides ownership: an expired claim nobody took over is still ours (completing
   * it records the published output); a takeover issued a new token, so the old one no longer matches.
   */
  private holds(key: string, token: string): boolean {
    const entry = this.entries.get(key);
    return entry?.state === "in-progress" && entry.token === token;
  }

  /** Bounded memory without timers: drop expired entries at most once per claim TTL. */
  private sweepExpired(now: number): void {
    if (now - this.lastSweep < this.claimTtlMs) return;
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
