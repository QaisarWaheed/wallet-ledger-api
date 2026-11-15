/**
 * Whole-database consistency check: the same SQL a reviewer would run after
 * a load test. Covers the seed data plus everything the other tests wrote.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbClient } from './helpers.js';

let db: pg.Client;

beforeAll(async () => {
  db = createDbClient();
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

async function count(sql: string): Promise<number> {
  const result = await db.query<{ count: string }>(sql);
  return Number(result.rows[0]?.count);
}

describe('global reconciliation', () => {
  it('every balance equals credits minus debits in the ledger, and no user is missing', async () => {
    expect(
      await count(`
        SELECT count(*) AS count
        FROM balances AS b
        FULL JOIN (
            SELECT user_id, sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS ledger_balance
            FROM ledger GROUP BY user_id
        ) AS l USING (user_id)
        WHERE b.balance IS DISTINCT FROM l.ledger_balance`),
    ).toBe(0);
  });

  it('no balance is negative', async () => {
    expect(await count('SELECT count(*) AS count FROM balances WHERE balance < 0')).toBe(0);
  });
});
