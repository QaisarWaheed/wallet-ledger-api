import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/errors.js';
import type { Movement, MovementOutcome } from '../../src/ledgerRepository.js';
import { WalletService } from '../../src/walletService.js';
import { InMemoryLedgerStore } from './inMemoryLedgerStore.js';

const fastRetry = { maxBatchSize: 64, retry: { maxAttempts: 3, baseDelayMs: 0 } };

describe('WalletService', () => {
  it('maps outcomes to balances and API errors', async () => {
    const wallet = new WalletService(new InMemoryLedgerStore(), fastRetry);
    await expect(wallet.debit('u', 1)).rejects.toMatchObject({ statusCode: 404, code: 'user_not_found' });
    await expect(wallet.getBalance('u')).rejects.toMatchObject({ statusCode: 404 });
    await expect(wallet.credit('u', 100)).resolves.toBe(100);
    await expect(wallet.debit('u', 101)).rejects.toMatchObject({ statusCode: 409, code: 'insufficient_funds' });
    await expect(wallet.debit('u', 100)).resolves.toBe(0);
    await expect(wallet.getBalance('u')).resolves.toBe(0);
  });

  it('batched concurrent debits of 60 against 100: exactly one succeeds', async () => {
    const store = new InMemoryLedgerStore();
    const wallet = new WalletService(store, fastRetry);
    await wallet.credit('u', 100);

    const results = await Promise.allSettled([wallet.debit('u', 60), wallet.debit('u', 60)]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
    expect(store.balances.get('u')).toBe(40);
  });

  it('retries a whole batch that hit a deadlock, applying each write once', async () => {
    class FlakyStore extends InMemoryLedgerStore {
      failuresLeft = 1;
      override async applyMovements(userId: string, movements: readonly Movement[]): Promise<MovementOutcome[]> {
        if (this.failuresLeft > 0) {
          this.failuresLeft -= 1;
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        }
        return super.applyMovements(userId, movements);
      }
    }
    const store = new FlakyStore();
    const wallet = new WalletService(store, fastRetry);

    await expect(wallet.credit('u', 50)).resolves.toBe(50);
    expect(store.balances.get('u')).toBe(50);
  });
});
