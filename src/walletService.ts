import { insufficientFunds, userNotFound } from './errors.js';
import { KeyedBatcher } from './keyedBatcher.js';
import type { LedgerStore, Movement, MovementOutcome } from './ledgerRepository.js';
import { DEFAULT_RETRY_OPTIONS, type RetryOptions, withRetry } from './retry.js';

/** The three wallet operations as the HTTP layer sees them. */
export interface Wallet {
  credit(userId: string, amount: number): Promise<number>;
  /** Throws user_not_found (404) or insufficient_funds (409). */
  debit(userId: string, amount: number): Promise<number>;
  /** Throws user_not_found (404). */
  getBalance(userId: string): Promise<number>;
  checkHealth(): Promise<void>;
}

export interface WalletOptions {
  /** Upper bound on writes per group commit; bounds how long a batch holds the row lock. */
  readonly maxBatchSize: number;
  readonly retry: RetryOptions;
}

export const DEFAULT_WALLET_OPTIONS: WalletOptions = { maxBatchSize: 64, retry: DEFAULT_RETRY_OPTIONS };

/**
 * Domain layer: groups each user's queued writes into one transaction,
 * retries transient conflicts, and turns outcomes into API errors.
 *
 * A retried batch is safe: PostgreSQL rolled the whole transaction back, so
 * none of its writes happened.
 *
 * Reads are deliberately NOT batched or queued: they take no locks (MVCC),
 * so a balance read on a hot user never waits behind that user's writes.
 */
export class WalletService implements Wallet {
  private readonly writes: KeyedBatcher<Movement, MovementOutcome>;

  constructor(
    private readonly store: LedgerStore,
    private readonly options: WalletOptions = DEFAULT_WALLET_OPTIONS,
  ) {
    this.writes = new KeyedBatcher(
      (userId, movements) => withRetry(() => store.applyMovements(userId, movements), options.retry),
      options.maxBatchSize,
    );
  }

  credit(userId: string, amount: number): Promise<number> {
    return this.write(userId, { type: 'credit', amount });
  }

  debit(userId: string, amount: number): Promise<number> {
    return this.write(userId, { type: 'debit', amount });
  }

  async getBalance(userId: string): Promise<number> {
    const balance = await withRetry(() => this.store.getBalance(userId), this.options.retry);
    if (balance === null) throw userNotFound();
    return balance;
  }

  checkHealth(): Promise<void> {
    return this.store.ping();
  }

  private async write(userId: string, movement: Movement): Promise<number> {
    const outcome = await this.writes.submit(userId, movement);
    switch (outcome.status) {
      case 'ok':
        return outcome.balance;
      case 'user_not_found':
        throw userNotFound();
      case 'insufficient_funds':
        throw insufficientFunds();
    }
  }
}
