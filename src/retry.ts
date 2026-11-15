/**
 * Retries transient database conflicts so they never surface as a 500.
 *
 * Only two SQLSTATEs are retried, both of which mean "PostgreSQL rolled the
 * whole transaction back, it is safe to run it again":
 *   40001 serialization_failure
 *   40P01 deadlock_detected
 * Anything else (including a lost connection, where the commit may or may
 * not have happened) is NOT retried, because re-running a write that may
 * already have committed would apply it twice.
 */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = { maxAttempts: 5, baseDelayMs: 5 };

export function isRetryableDbError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_SQLSTATES.has(code);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = DEFAULT_RETRY_OPTIONS): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableDbError(error) || attempt >= options.maxAttempts) throw error;
      // Exponential backoff with full jitter, so retrying requests spread out
      // instead of colliding again at the same moment.
      const ceiling = options.baseDelayMs * 2 ** (attempt - 1);
      await sleep(Math.random() * ceiling);
    }
  }
}
