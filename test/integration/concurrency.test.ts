/**
 * The six concurrency rules from the brief, each tested with real parallel
 * HTTP requests against the running API, then checked against the ledger.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPLY_MOVEMENTS_SQL } from '../../src/ledgerRepository.js';
import {
  call,
  createDbClient,
  credit,
  debit,
  expectReconciled,
  getBalance,
  ledgerRowCount,
  percentile,
  runFor,
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

const countStatuses = (statuses: readonly number[]): Record<number, number> =>
  statuses.reduce<Record<number, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});

describe('1. Non-negative balance', () => {
  it('two concurrent debits of 60 against 100 give exactly one 200 and one 409 (repeated 25 times)', async () => {
    for (let round = 0; round < 25; round += 1) {
      const user = uniqueUserId('race2');
      await credit(user, 100);

      const results = await Promise.all([debit(user, 60), debit(user, 60)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await getBalance(user)).body['balance']).toBe(40);
      expect(await expectReconciled(db, user)).toBe(40);
    }
  });

  it('50 concurrent debits of 60 against 1000: exactly 16 succeed, balance ends at 40', async () => {
    const user = uniqueUserId('race50');
    await credit(user, 1000);

    const results = await Promise.all(Array.from({ length: 50 }, () => debit(user, 60)));

    expect(countStatuses(results.map((r) => r.status))).toEqual({ 200: 16, 409: 34 });
    expect(await expectReconciled(db, user)).toBe(40);
    expect(await ledgerRowCount(db, user)).toBe(1 + 16);
  });
});

describe('2. No lost updates', () => {
  it('1,000 concurrent credits of 100 raise the balance by exactly 100,000', async () => {
    const user = uniqueUserId('credits1k');
    await credit(user, 1);

    const results = await Promise.all(Array.from({ length: 1000 }, () => credit(user, 100)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await getBalance(user)).body['balance']).toBe(100_001);
    expect(await expectReconciled(db, user)).toBe(100_001);
    expect(await ledgerRowCount(db, user)).toBe(1001);
  });

  it('concurrent first credits for a brand-new user are all counted', async () => {
    const user = uniqueUserId('firstcredit');
    const results = await Promise.all(Array.from({ length: 50 }, () => credit(user, 10)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await expectReconciled(db, user)).toBe(500);
  });
});

describe('3. Atomicity', () => {
  it('a connection killed mid-transaction leaves no partial write', async () => {
    const user = uniqueUserId('crash');
    await credit(user, 100);
    const rowsBefore = await ledgerRowCount(db, user);

    // A second connection runs the real debit statement inside an open
    // transaction, then "crashes" (its backend is terminated) before COMMIT.
    const victim = createDbClient();
    victim.on('error', () => undefined); // expected: the connection gets killed
    await victim.connect();
    const pidResult = await victim.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = pidResult.rows[0]?.pid;
    await victim.query('BEGIN');
    const inFlight = await victim.query<{ new_balance: string }>(APPLY_MOVEMENTS_SQL, [user, ['debit'], [30]]);
    expect(Number(inFlight.rows[0]?.new_balance)).toBe(70); // the write happened inside the transaction...

    // ...but nobody else can see it before commit (no dirty reads).
    expect((await getBalance(user)).body['balance']).toBe(100);

    await db.query('SELECT pg_terminate_backend($1)', [pid]);
    await victim.end().catch(() => undefined);

    expect(await ledgerRowCount(db, user)).toBe(rowsBefore);
    expect(await expectReconciled(db, user)).toBe(100);
    // The row lock was released by the rollback: the API can write again.
    expect(await debit(user, 30)).toMatchObject({ status: 200, body: { balance: 70 } });
  });

  it('the database itself refuses a negative balance (constraint as last line of defence)', async () => {
    const user = uniqueUserId('constraint');
    await credit(user, 10);
    await expect(db.query('UPDATE balances SET balance = -1 WHERE user_id = $1', [user])).rejects.toThrow(
      /balances_non_negative/,
    );
  });
});

describe('4. Read-your-writes', () => {
  it('every balance read after a 200 reflects that write', async () => {
    const user = uniqueUserId('ryw');
    let expected = 0;
    for (let i = 0; i < 100; i += 1) {
      const isCredit = i % 3 !== 2;
      const response = isCredit ? await credit(user, 50) : await debit(user, 30);
      expect(response.status).toBe(200);
      expected += isCredit ? 50 : -30;
      expect(response.body['balance']).toBe(expected);
      expect((await getBalance(user)).body['balance']).toBe(expected);
    }
  });
});

describe('5. Isolation across users', () => {
  it('a hot user under heavy write load does not slow down other users', async () => {
    const others = Array.from({ length: 50 }, () => uniqueUserId('calm'));
    await Promise.all(others.map((u) => credit(u, 1_000_000)));
    const hot = uniqueUserId('hot');
    await credit(hot, 1_000_000);

    const measureOthers = async (): Promise<number[]> => {
      const latencies: number[] = [];
      await runFor(3_000, 10, async (loop) => {
        const user = others[(loop * 7 + latencies.length) % others.length] ?? others[0]!;
        const response = latencies.length % 2 === 0 ? await getBalance(user) : await credit(user, 1);
        expect(response.status).toBe(200);
        latencies.push(response.latencyMs);
      });
      return latencies;
    };

    const baseline = await measureOthers();

    let hotSuccesses = 0;
    let hotRunning = true;
    const hotLoad = Promise.all(
      Array.from({ length: 150 }, async () => {
        while (hotRunning) {
          const response = await credit(hot, 1);
          expect(response.status).toBe(200);
          hotSuccesses += 1;
        }
      }),
    );
    const underLoad = await measureOthers();
    hotRunning = false;
    await hotLoad;

    const baselineP99 = percentile(baseline, 99);
    const underLoadP99 = percentile(underLoad, 99);
    console.info(
      `isolation: other users p99 baseline=${baselineP99.toFixed(1)}ms, ` +
        `with 150 writers on one hot user=${underLoadP99.toFixed(1)}ms (${hotSuccesses} hot writes)`,
    );

    // Generous bound so the test is stable on slow machines; the load-test
    // report shows the real numbers.
    expect(underLoadP99).toBeLessThan(Math.max(50, baselineP99 * 5));
    expect(await expectReconciled(db, hot)).toBe(1_000_000 + hotSuccesses);
  });
});

describe('6. No silent failures', () => {
  it('a storm of mixed operations on a few contended users returns only 200/409 and stays consistent', async () => {
    const users = Array.from({ length: 5 }, () => uniqueUserId('storm'));
    await Promise.all(users.map((u) => credit(u, 5_000)));

    const statuses: number[] = [];
    await Promise.all(
      Array.from({ length: 3000 }, async (_, i) => {
        const user = users[i % users.length]!;
        const roll = (i * 7919) % 10;
        const response =
          roll < 4 ? await debit(user, 1 + ((i * 31) % 3000)) : roll < 7 ? await credit(user, 1 + ((i * 17) % 2000)) : await getBalance(user);
        statuses.push(response.status);
      }),
    );

    const unexpected = statuses.filter((s) => s !== 200 && s !== 409);
    expect(unexpected, JSON.stringify(countStatuses(statuses))).toEqual([]);
    for (const user of users) await expectReconciled(db, user);
  });

  it('malformed traffic mixed in does not produce 5xx', async () => {
    const user = uniqueUserId('noise');
    await credit(user, 100);
    const responses = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        i % 2 === 0 ? call('POST', '/debit', undefined, { rawBody: '{"user_id":' }) : debit(user, 1),
      ),
    );
    expect(responses.every((r) => r.status < 500)).toBe(true);
    expect(await expectReconciled(db, user)).toBe(0);
  });
});
