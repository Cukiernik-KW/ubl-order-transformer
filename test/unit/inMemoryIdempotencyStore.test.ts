import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "../../src/adapters/inMemoryIdempotencyStore.js";
import {
  CONTRACT_CLAIM_TTL_MS,
  CONTRACT_TTL_MS,
  describeIdempotencyStoreContract,
} from "../contract/idempotencyStore.contract.js";
import { fixedClock } from "../helpers/index.js";

// One process = one instance: "another instance" shares the same store object.
describeIdempotencyStoreContract("InMemoryIdempotencyStore", (clock) => {
  const store = new InMemoryIdempotencyStore<unknown>({
    ttlMs: CONTRACT_TTL_MS,
    claimTtlMs: CONTRACT_CLAIM_TTL_MS,
    clock,
  });
  return { store, newInstance: () => store };
});

describe("InMemoryIdempotencyStore", () => {
  it("sweeps expired entries so memory stays bounded", async () => {
    const clock = fixedClock("2026-01-01T00:00:00Z");
    const store = new InMemoryIdempotencyStore<string>({ ttlMs: 3_600_000, clock });
    for (const key of ["a", "b", "c"]) {
      const result = await store.tryClaim(key);
      if (result.status === "claimed") await store.complete(key, result.token, key);
    }
    expect(store.size).toBe(3);
    clock.set("2026-01-01T02:00:00Z");
    await store.tryClaim("d");
    expect(store.size).toBe(1);
  });
});
