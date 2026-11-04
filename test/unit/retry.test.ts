import { describe, expect, it, vi } from "vitest";
import { invalidXml, serverError } from "../../src/domain/errors.js";
import { isRetryable, withRetry } from "../../src/pipeline/retry.js";

function failing(errors: Error[], value = "ok") {
  return vi.fn(() => {
    const error = errors.shift();
    return error === undefined ? Promise.resolve(value) : Promise.reject(error);
  });
}

describe("withRetry", () => {
  it("returns the result of the first successful attempt", async () => {
    const operation = failing([]);
    await expect(withRetry(operation, { maxAttempts: 3, baseDelayMs: 100 })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors until an attempt succeeds", async () => {
    const operation = failing([serverError(), serverError()]);
    const sleep = vi.fn(() => Promise.resolve());
    await expect(withRetry(operation, { maxAttempts: 3, baseDelayMs: 100, sleep })).resolves.toBe(
      "ok",
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const last = serverError(new Error("third"));
    const operation = failing([serverError(), serverError(), last]);
    await expect(
      withRetry(operation, { maxAttempts: 3, baseDelayMs: 1, sleep: () => Promise.resolve() }),
    ).rejects.toBe(last);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("never retries a permanent error", async () => {
    const permanent = invalidXml();
    const operation = failing([permanent]);
    await expect(withRetry(operation, { maxAttempts: 5, baseDelayMs: 1 })).rejects.toBe(permanent);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries unknown (non-AppError) errors", async () => {
    const operation = failing([new Error("ECONNRESET")]);
    await expect(
      withRetry(operation, { maxAttempts: 2, baseDelayMs: 1, sleep: () => Promise.resolve() }),
    ).resolves.toBe("ok");
  });

  it("uses exponential backoff with full jitter, capped at maxDelayMs", async () => {
    const delays: number[] = [];
    const operation = failing([serverError(), serverError(), serverError(), serverError()]);
    await withRetry(operation, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 300,
      random: () => 0.999999, // upper edge of the jitter window
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    // caps: 100, 200, 400 -> 300, 800 -> 300
    expect(delays).toEqual([99, 199, 299, 299]);
  });

  it("can pick a zero delay (full jitter, not 'equal' jitter)", async () => {
    const delays: number[] = [];
    await withRetry(failing([serverError()]), {
      maxAttempts: 2,
      baseDelayMs: 100,
      random: () => 0,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(delays).toEqual([0]);
  });

  it("reports each retry", async () => {
    const onRetry = vi.fn();
    const error = serverError();
    await withRetry(failing([error]), {
      maxAttempts: 2,
      baseDelayMs: 100,
      random: () => 0.5,
      sleep: () => Promise.resolve(),
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 50, error });
  });
});

describe("isRetryable", () => {
  it("is false only for permanent AppErrors", () => {
    expect(isRetryable(invalidXml())).toBe(false);
    expect(isRetryable(serverError())).toBe(true);
    expect(isRetryable(new Error("boom"))).toBe(true);
  });
});
