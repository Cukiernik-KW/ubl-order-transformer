import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "../../src/adapters/inMemoryIdempotencyStore.js";
import { fixedClock } from "../helpers/index.js";

function setup() {
  const clock = fixedClock("2026-01-01T00:00:00Z");
  const store = new InMemoryIdempotencyStore<string>({
    ttlMs: 60 * 60_000,
    claimTtlMs: 60_000,
    clock,
  });
  return { clock, store };
}

describe("InMemoryIdempotencyStore", () => {
  it("claims an unknown key", async () => {
    const { store } = setup();
    await expect(store.tryClaim("m1")).resolves.toEqual({ status: "claimed" });
  });

  it("reports a claimed key as in-progress", async () => {
    const { store } = setup();
    await store.tryClaim("m1");
    await expect(store.tryClaim("m1")).resolves.toEqual({ status: "in-progress" });
  });

  it("returns the stored result for a completed key", async () => {
    const { store } = setup();
    await store.tryClaim("m1");
    await store.complete("m1", "output-1");
    await expect(store.tryClaim("m1")).resolves.toEqual({
      status: "completed",
      result: "output-1",
    });
  });

  it("lets a released key be claimed again", async () => {
    const { store } = setup();
    await store.tryClaim("m1");
    await store.release("m1");
    await expect(store.tryClaim("m1")).resolves.toEqual({ status: "claimed" });
  });

  it("only one of two concurrent claims wins", async () => {
    const { store } = setup();
    const results = await Promise.all([store.tryClaim("m1"), store.tryClaim("m1")]);
    expect(results.map((r) => r.status).sort()).toEqual(["claimed", "in-progress"]);
  });

  it("expires a stale claim, so a hung request cannot block the key forever", async () => {
    const { clock, store } = setup();
    await store.tryClaim("m1");
    clock.set("2026-01-01T00:01:00Z"); // exactly claimTtl later
    await expect(store.tryClaim("m1")).resolves.toEqual({ status: "claimed" });
  });

  it("forgets a completed key after the TTL", async () => {
    const { clock, store } = setup();
    await store.tryClaim("m1");
    await store.complete("m1", "output-1");
    clock.set("2026-01-01T00:59:59Z");
    await expect(store.tryClaim("m1")).resolves.toMatchObject({ status: "completed" });
    clock.set("2026-01-01T01:00:00Z");
    await expect(store.tryClaim("m1")).resolves.toEqual({ status: "claimed" });
  });

  it("sweeps expired entries so memory stays bounded", async () => {
    const { clock, store } = setup();
    for (const key of ["a", "b", "c"]) {
      await store.tryClaim(key);
      await store.complete(key, key);
    }
    expect(store.size).toBe(3);
    clock.set("2026-01-01T02:00:00Z");
    await store.tryClaim("d");
    expect(store.size).toBe(1);
  });
});
