import { AppError } from "../domain/errors.js";

export interface RetryOptions {
  /** Total attempts including the first one (1 = no retry). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Injected in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests for deterministic jitter. Must return a value in [0, 1). */
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Permanent errors fail the same way every time, so retrying them only wastes time. */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof AppError && error.permanent);
}

/**
 * Exponential backoff with full jitter: delay = random() * min(maxDelay, base * 2^(attempt-1)).
 * Jitter spreads retries from many instances over time, so they don't hit a recovering
 * dependency at the same moment (thundering herd).
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs = 5_000,
    sleep = defaultSleep,
    random = Math.random,
    onRetry,
  } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.floor(random() * cap);
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
