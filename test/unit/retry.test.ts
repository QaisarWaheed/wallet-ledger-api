import { describe, expect, it, vi } from 'vitest';
import { isRetryableDbError, withRetry } from '../../src/retry.js';

const fast = { maxAttempts: 3, baseDelayMs: 0 };
const dbError = (code: string): Error => Object.assign(new Error(`db error ${code}`), { code });

describe('isRetryableDbError', () => {
  it.each(['40001', '40P01'])('retries SQLSTATE %s', (code) => {
    expect(isRetryableDbError(dbError(code))).toBe(true);
  });

  it.each(['23505', '23514', '57P01', '08006'])('does not retry SQLSTATE %s', (code) => {
    expect(isRetryableDbError(dbError(code))).toBe(false);
  });

  it('does not retry non-database errors', () => {
    expect(isRetryableDbError(new Error('plain'))).toBe(false);
    expect(isRetryableDbError(null)).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries a deadlock and returns the eventual result', async () => {
    const operation = vi.fn().mockRejectedValueOnce(dbError('40P01')).mockResolvedValueOnce('done');
    await expect(withRetry(operation, fast)).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const operation = vi.fn().mockRejectedValue(dbError('40001'));
    await expect(withRetry(operation, fast)).rejects.toMatchObject({ code: '40001' });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const operation = vi.fn().mockRejectedValue(dbError('23514'));
    await expect(withRetry(operation, fast)).rejects.toMatchObject({ code: '23514' });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
