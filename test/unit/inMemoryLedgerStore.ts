import type { LedgerStore, Movement, MovementOutcome } from '../../src/ledgerRepository.js';

/** A LedgerStore in memory with the same rules as the SQL, for tests without a database. */
export class InMemoryLedgerStore implements LedgerStore {
  readonly balances = new Map<string, number>();

  async applyMovements(userId: string, movements: readonly Movement[]): Promise<MovementOutcome[]> {
    return movements.map((movement) => this.apply(userId, movement));
  }

  async getBalance(userId: string): Promise<number | null> {
    return this.balances.get(userId) ?? null;
  }

  async ping(): Promise<void> {}

  private apply(userId: string, { type, amount }: Movement): MovementOutcome {
    const current = this.balances.get(userId);
    if (type === 'credit') {
      const balance = (current ?? 0) + amount;
      this.balances.set(userId, balance);
      return { status: 'ok', balance };
    }
    if (current === undefined) return { status: 'user_not_found' };
    if (current < amount) return { status: 'insufficient_funds' };
    this.balances.set(userId, current - amount);
    return { status: 'ok', balance: current - amount };
  }
}
