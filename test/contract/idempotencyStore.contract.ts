import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/ports/clock.js";
import type { ClaimResult, IdempotencyStore } from "../../src/ports/idempotencyStore.js";
import { fixedClock } from "../helpers/index.js";

/** TTLs every implementation under test is configured with. */
export const CONTRACT_TTL_MS = 60 * 60_000;
export const CONTRACT_CLAIM_TTL_MS = 60_000;

export interface ContractHarness {
  /** A store backed by the shared state. */
  store: IdempotencyStore<unknown>;
  /** Another "instance" (own client, same backing state); in-memory returns the same store. */
  newInstance: () => IdempotencyStore<unknown>;
}

type Claimed = Extract<ClaimResult<unknown>, { status: "claimed" }>;

async function claim(store: IdempotencyStore<unknown>, key: string): Promise<Claimed> {
  const result = await store.tryClaim(key);
  expect(result.status).toBe("claimed");
  return result as Claimed;
}

/**
 * The behaviour the processor relies on (ports/idempotencyStore.ts), run against every adapter, so
 * a new implementation (Firestore, later Redis) is checked by the same tests as the in-memory one.
 */
export function describeIdempotencyStoreContract(
  name: string,
  setup: (clock: Clock) => ContractHarness,
): void {
  describe(`${name}: IdempotencyStore contract`, () => {
    function start() {
      const clock = fixedClock("2026-01-01T00:00:00Z");
      return { clock, ...setup(clock) };
    }

    it("claims an unknown key and returns a token", async () => {
      const { store } = start();
      const result = await claim(store, "m1");
      expect(result.token).toEqual(expect.any(String));
    });

    it("reports a claimed key as in-progress", async () => {
      const { store } = start();
      await claim(store, "m1");
      await expect(store.tryClaim("m1")).resolves.toEqual({ status: "in-progress" });
    });

    it("returns the stored result verbatim (including key order) for a completed key", async () => {
      const { store } = start();
      const { token } = await claim(store, "m1");
      const output = { messageId: "m1", order: { z: 1, a: [2, 3] }, lines: [], ref: null };
      await store.complete("m1", token, output);

      const result = await store.tryClaim("m1");
      expect(result).toEqual({ status: "completed", result: output });
      if (result.status !== "completed") throw new Error("unreachable");
      expect(JSON.stringify(result.result)).toBe(JSON.stringify(output));
    });

    it("lets a released key be claimed again, with a new token", async () => {
      const { store } = start();
      const first = await claim(store, "m1");
      await store.release("m1", first.token);
      const second = await claim(store, "m1");
      expect(second.token).not.toBe(first.token);
    });

    it("lets exactly one of many concurrent claims from different instances win", async () => {
      const { newInstance } = start();
      const instances = Array.from({ length: 10 }, () => newInstance());
      const results = await Promise.all(instances.map((store) => store.tryClaim("race")));
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === "claimed")).toHaveLength(1);
      expect(statuses.filter((s) => s === "in-progress")).toHaveLength(9);
    });

    it("lets another instance take over an expired claim (crashed holder)", async () => {
      const { clock, store, newInstance } = start();
      const stale = await claim(store, "m1");
      clock.set("2026-01-01T00:01:00Z"); // exactly the claim TTL later
      const fresh = await claim(newInstance(), "m1");
      expect(fresh.token).not.toBe(stale.token);
    });

    it("ignores complete() with a stale token after a takeover", async () => {
      const { clock, store, newInstance } = start();
      const stale = await claim(store, "m1");
      clock.set("2026-01-01T00:01:00Z");
      const other = newInstance();
      const fresh = await claim(other, "m1");

      await store.complete("m1", stale.token, "late output");
      await expect(other.tryClaim("m1")).resolves.toEqual({ status: "in-progress" });

      await other.complete("m1", fresh.token, "fresh output");
      await expect(store.tryClaim("m1")).resolves.toEqual({
        status: "completed",
        result: "fresh output",
      });
    });

    it("ignores release() with a stale token after a takeover", async () => {
      const { clock, store, newInstance } = start();
      const stale = await claim(store, "m1");
      clock.set("2026-01-01T00:01:00Z");
      await claim(newInstance(), "m1");

      await store.release("m1", stale.token);
      await expect(store.tryClaim("m1")).resolves.toEqual({ status: "in-progress" });
    });

    it("still completes an expired claim that nobody took over (the token still matches)", async () => {
      const { clock, store } = start();
      const { token } = await claim(store, "m1");
      clock.set("2026-01-01T00:05:00Z");
      await store.complete("m1", token, "slow output");
      await expect(store.tryClaim("m1")).resolves.toEqual({
        status: "completed",
        result: "slow output",
      });
    });

    it("ignores complete() after release() (the claim is gone)", async () => {
      const { store } = start();
      const { token } = await claim(store, "m1");
      await store.release("m1", token);
      await store.complete("m1", token, "output");
      await claim(store, "m1");
    });

    it("forgets a completed key after the TTL", async () => {
      const { clock, store } = start();
      const { token } = await claim(store, "m1");
      await store.complete("m1", token, "output");
      clock.set("2026-01-01T00:59:59Z");
      await expect(store.tryClaim("m1")).resolves.toMatchObject({ status: "completed" });
      clock.set("2026-01-01T01:00:00Z"); // exactly the TTL later
      await claim(store, "m1");
    });

    it("keeps distinct keys independent, including keys with '/' and non-ASCII characters", async () => {
      const { store } = start();
      for (const key of ["a/b", "a_b", "a%2Fb", "zamówienie-ż", ".."]) await claim(store, key);
    });
  });
}
