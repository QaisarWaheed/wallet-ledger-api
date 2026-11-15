import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createDbClient,
  credit,
  debit,
  expectReconciled,
  getBalance,
  ledgerRowCount,
  uniqueUserId,
} from './helpers.js';

let db: pg.Client;

beforeAll(async () => {
  db = createDbClient();
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

describe('API contract against the real stack', () => {
  it('credit creates the user, then debit and balance follow the example in the brief', async () => {
    const user = uniqueUserId('contract');
    expect(await credit(user, 15000)).toMatchObject({ status: 200, body: { user_id: user, balance: 15000 } });
    expect(await credit(user, 10000)).toMatchObject({ status: 200, body: { user_id: user, balance: 25000 } });
    expect(await debit(user, 4000)).toMatchObject({ status: 200, body: { user_id: user, balance: 21000 } });
    expect(await getBalance(user)).toMatchObject({ status: 200, body: { user_id: user, balance: 21000 } });
    await expectReconciled(db, user);
  });

  it('stores every operation as one immutable ledger row', async () => {
    const user = uniqueUserId('rows');
    await credit(user, 500);
    await debit(user, 200);
    const rows = await db.query<{ type: string; amount: string; created_at: Date }>(
      'SELECT type, amount, created_at FROM ledger WHERE user_id = $1 ORDER BY id',
      [user],
    );
    expect(rows.rows.map((r) => [r.type, Number(r.amount)])).toEqual([
      ['credit', 500],
      ['debit', 200],
    ]);
    expect(rows.rows.every((r) => r.created_at instanceof Date)).toBe(true);

    await expect(db.query('UPDATE ledger SET amount = 1 WHERE user_id = $1', [user])).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM ledger WHERE user_id = $1', [user])).rejects.toThrow(/append-only/);
  });

  it('404 for balance and debit of a user that was never credited', async () => {
    const user = uniqueUserId('ghost');
    expect(await getBalance(user)).toMatchObject({ status: 404, body: { error: 'user_not_found' } });
    expect(await debit(user, 1)).toMatchObject({ status: 404, body: { error: 'user_not_found' } });
    expect(await ledgerRowCount(db, user)).toBe(0);
  });

  it('409 when the debit exceeds the balance, and nothing is written', async () => {
    const user = uniqueUserId('overdraw');
    await credit(user, 100);
    const rowsBefore = await ledgerRowCount(db, user);

    expect(await debit(user, 101)).toMatchObject({ status: 409, body: { error: 'insufficient_funds' } });
    expect(await ledgerRowCount(db, user)).toBe(rowsBefore);
    expect(await getBalance(user)).toMatchObject({ body: { balance: 100 } });
  });

  it('401 on every endpoint without a valid token', async () => {
    const user = uniqueUserId('auth');
    for (const authorization of [undefined, 'Bearer wrong', 'Basic recruitment-test-token']) {
      const headers = { authorization };
      expect((await call('POST', '/credit', { user_id: user, amount: 1 }, { headers })).status).toBe(401);
      expect((await call('POST', '/debit', { user_id: user, amount: 1 }, { headers })).status).toBe(401);
      expect((await call('GET', `/balance/${user}`, undefined, { headers })).status).toBe(401);
    }
    expect(await ledgerRowCount(db, user)).toBe(0);
  });

  it('400 for invalid input, with nothing written', async () => {
    const user = uniqueUserId('invalid');
    const cases = [
      '{"user_id": "x", "amount": 1.0}',
      '{"user_id": "x", "amount": "5"}',
      '{"user_id": "x", "amount": 0}',
      '{"user_id": "x", "amount": -1}',
      '{"user_id": "x", "amount": 1000000001}',
      '{"user_id": "bad id", "amount": 5}',
      '{"user_id": "x"',
    ].map((body) => body.replace('"x"', JSON.stringify(user)));

    for (const rawBody of cases) {
      const response = await call('POST', '/credit', undefined, { rawBody });
      expect(response, rawBody).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await ledgerRowCount(db, user)).toBe(0);
  });
});
