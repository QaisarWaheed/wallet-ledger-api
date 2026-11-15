import type { Pool } from 'pg';

/**
 * All SQL lives here.
 *
 * Every write goes through the database function apply_movements (see
 * db/schema.sql). One call is one statement, therefore one transaction and
 * one network round trip, whether it carries a single credit/debit or a
 * batch of queued writes for the same user. Inside it, each credit/debit
 * changes the balance row and inserts the ledger row together, so the two
 * can never disagree.
 *
 * Isolation level: READ COMMITTED (the PostgreSQL default). See schema.sql
 * for why the row lock plus the conditional UPDATE is enough.
 */
export const APPLY_MOVEMENTS_SQL = `
SELECT item, outcome, new_balance
FROM apply_movements($1::text, $2::ledger_entry_type[], $3::bigint[])
ORDER BY item`;

/** Primary-key lookup: cost does not depend on ledger size or user history. */
export const BALANCE_SQL = `SELECT balance FROM balances WHERE user_id = $1::text`;

export interface Movement {
  readonly type: 'credit' | 'debit';
  readonly amount: number;
}

export type MovementOutcome =
  | { readonly status: 'ok'; readonly balance: number }
  | { readonly status: 'user_not_found' }
  | { readonly status: 'insufficient_funds' };

/** Data-access contract used by the wallet service (and faked in unit tests). */
export interface LedgerStore {
  /**
   * Applies the movements of ONE user in order, atomically as a group, and
   * returns one outcome per movement. A rejected debit (404/409) writes
   * nothing and does not affect the other movements.
   */
  applyMovements(userId: string, movements: readonly Movement[]): Promise<MovementOutcome[]>;
  /** Returns null when the user has never been credited. */
  getBalance(userId: string): Promise<number | null>;
  ping(): Promise<void>;
}

interface OutcomeRow {
  item: number;
  outcome: 'ok' | 'user_not_found' | 'insufficient_funds';
  new_balance: string | null; // node-postgres returns bigint as string
}

/** Converts a bigint column to a number, refusing values JSON numbers cannot hold exactly. */
function toSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Balance ${value} exceeds the safe integer range`);
  }
  return parsed;
}

function toOutcome(row: OutcomeRow): MovementOutcome {
  switch (row.outcome) {
    case 'ok':
      if (row.new_balance === null) throw new Error('apply_movements returned ok without a balance');
      return { status: 'ok', balance: toSafeInteger(row.new_balance) };
    case 'user_not_found':
    case 'insufficient_funds':
      return { status: row.outcome };
    default:
      throw new Error(`Unexpected outcome from apply_movements: ${String(row.outcome)}`);
  }
}

export class PostgresLedgerStore implements LedgerStore {
  constructor(private readonly pool: Pool) {}

  async applyMovements(userId: string, movements: readonly Movement[]): Promise<MovementOutcome[]> {
    // Named queries become per-connection prepared statements: parsed and
    // planned once, then reused.
    const result = await this.pool.query<OutcomeRow>({
      name: 'apply_movements',
      text: APPLY_MOVEMENTS_SQL,
      values: [userId, movements.map((m) => m.type), movements.map((m) => m.amount)],
    });
    if (result.rows.length !== movements.length) {
      throw new Error(`apply_movements returned ${result.rows.length} rows for ${movements.length} movements`);
    }
    return result.rows.map(toOutcome);
  }

  async getBalance(userId: string): Promise<number | null> {
    const result = await this.pool.query<{ balance: string }>({ name: 'balance', text: BALANCE_SQL, values: [userId] });
    const row = result.rows[0];
    return row === undefined ? null : toSafeInteger(row.balance);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
