/**
 * Shared helpers for integration tests. They run against the real stack
 * started with `docker compose up` (API on :8080, database on :55432).
 */
import pg from 'pg';
import { Agent, request } from 'undici';

export const BASE_URL = process.env['API_URL'] || 'http://localhost:8080';
export const API_TOKEN = process.env['API_TOKEN'] || 'recruitment-test-token';
export const DATABASE_URL = process.env['TEST_DATABASE_URL'] || 'postgres://ledger:ledger@127.0.0.1:55432/ledger';

const dispatcher = new Agent({ connections: 256, keepAliveTimeout: 10_000 });

export interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly latencyMs: number;
}

export interface CallOptions {
  /** Raw body text, sent as-is (for malformed JSON tests). */
  readonly rawBody?: string;
  /** Header overrides; set authorization to undefined to omit it. */
  readonly headers?: Record<string, string | undefined>;
}

export async function call(
  method: 'GET' | 'POST',
  path: string,
  json?: unknown,
  options: CallOptions = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  const merged = { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json', ...options.headers };
  for (const [name, value] of Object.entries(merged)) if (value !== undefined) headers[name] = value;

  const body = options.rawBody ?? (json === undefined ? undefined : JSON.stringify(json));
  const started = performance.now();
  const response = await request(`${BASE_URL}${path}`, { method, headers, body: body ?? null, dispatcher });
  const text = await response.body.text();
  const latencyMs = performance.now() - started;
  return { status: response.statusCode, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), latencyMs };
}

export const credit = (userId: string, amount: number): Promise<ApiResponse> =>
  call('POST', '/credit', { user_id: userId, amount });

export const debit = (userId: string, amount: number): Promise<ApiResponse> =>
  call('POST', '/debit', { user_id: userId, amount });

export const getBalance = (userId: string): Promise<ApiResponse> => call('GET', `/balance/${userId}`);

const RUN_ID = Date.now().toString(36);
let userCounter = 0;

/** A user id no other test (or earlier run) has used. */
export function uniqueUserId(label: string): string {
  userCounter += 1;
  return `t_${RUN_ID}_${label}_${userCounter}`.slice(0, 64);
}

export function createDbClient(): pg.Client {
  return new pg.Client({ connectionString: DATABASE_URL });
}

/** SUM(credits) - SUM(debits) straight from the ledger, the source of truth. */
export async function ledgerBalance(db: pg.Client, userId: string): Promise<number> {
  const result = await db.query<{ balance: string }>(
    `SELECT coalesce(sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS balance
     FROM ledger WHERE user_id = $1`,
    [userId],
  );
  return Number(result.rows[0]?.balance ?? 0);
}

export async function storedBalance(db: pg.Client, userId: string): Promise<number | null> {
  const result = await db.query<{ balance: string }>('SELECT balance FROM balances WHERE user_id = $1', [userId]);
  const row = result.rows[0];
  return row === undefined ? null : Number(row.balance);
}

export async function ledgerRowCount(db: pg.Client, userId: string): Promise<number> {
  const result = await db.query<{ count: string }>('SELECT count(*) AS count FROM ledger WHERE user_id = $1', [userId]);
  return Number(result.rows[0]?.count ?? 0);
}

/** Asserts the balances row equals the ledger sum and is non-negative. */
export async function expectReconciled(db: pg.Client, userId: string): Promise<number> {
  const [stored, fromLedger] = await Promise.all([storedBalance(db, userId), ledgerBalance(db, userId)]);
  if (stored !== fromLedger) throw new Error(`User ${userId}: stored balance ${stored} != ledger balance ${fromLedger}`);
  if (fromLedger < 0) throw new Error(`User ${userId}: negative balance ${fromLedger}`);
  return fromLedger;
}

/** Nearest-rank percentile of a list of numbers. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN;
}

/** Runs `worker` from `concurrency` loops until `durationMs` has passed. */
export async function runFor(durationMs: number, concurrency: number, worker: (loop: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + durationMs;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, loop) => {
      while (Date.now() < deadline) await worker(loop);
    }),
  );
}
