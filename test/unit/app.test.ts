import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createTokenVerifier } from '../../src/auth.js';
import type { Movement, MovementOutcome } from '../../src/ledgerRepository.js';
import { WalletService } from '../../src/walletService.js';
import { InMemoryLedgerStore } from './inMemoryLedgerStore.js';

/** In-memory store that also counts calls, to prove rejected requests never reach it. */
class FakeLedgerStore extends InMemoryLedgerStore {
  calls = 0;

  override applyMovements(userId: string, movements: readonly Movement[]): Promise<MovementOutcome[]> {
    this.calls += 1;
    return super.applyMovements(userId, movements);
  }

  override getBalance(userId: string): Promise<number | null> {
    this.calls += 1;
    return super.getBalance(userId);
  }
}

const TOKEN = 'unit-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let store: FakeLedgerStore;
let app: FastifyInstance;

beforeEach(async () => {
  store = new FakeLedgerStore();
  app = buildApp({
    verifyToken: createTokenVerifier(TOKEN),
    wallet: new WalletService(store),
    logLevel: 'silent',
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

describe('authentication', () => {
  const requests = [
    { method: 'POST' as const, url: '/credit', payload: '{"user_id":"u1","amount":1}' },
    { method: 'POST' as const, url: '/debit', payload: '{"user_id":"u1","amount":1}' },
    { method: 'GET' as const, url: '/balance/u1' },
    { method: 'GET' as const, url: '/health' },
    { method: 'GET' as const, url: '/no-such-route' },
  ];
  const badHeaders: Array<[string, Record<string, string>]> = [
    ['no header', {}],
    ['wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['wrong token', { authorization: 'Bearer nope' }],
  ];

  for (const request of requests) {
    for (const [label, headers] of badHeaders) {
      it(`${request.method} ${request.url} with ${label} -> 401 and no store access`, async () => {
        const response = await app.inject({ ...request, headers: { 'content-type': 'application/json', ...headers } });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'unauthorized', message: expect.any(String) });
        expect(store.calls).toBe(0);
      });
    }
  }

  it('checks auth before parsing the body: malformed JSON without a token is 401, not 400', async () => {
    const response = await post('/credit', '{not json', {});
    expect(response.statusCode).toBe(401);
  });

  it('never echoes the token back', async () => {
    const response = await post('/credit', '{bad', AUTH);
    expect(response.body).not.toContain(TOKEN);
  });
});

describe('credit, debit and balance', () => {
  it('creates a user on first credit and returns the new balance', async () => {
    const response = await post('/credit', { user_id: 'u123', amount: 10000 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user_id: 'u123', balance: 10000 });
  });

  it('debits and returns the balance after the operation', async () => {
    await post('/credit', { user_id: 'u123', amount: 25000 });
    const response = await post('/debit', { user_id: 'u123', amount: 4000 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user_id: 'u123', balance: 21000 });
  });

  it('returns the current balance', async () => {
    await post('/credit', { user_id: 'u123', amount: 21000 });
    const response = await app.inject({ method: 'GET', url: '/balance/u123', headers: AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user_id: 'u123', balance: 21000 });
  });

  it('returns 404 for the balance of an unknown user', async () => {
    const response = await app.inject({ method: 'GET', url: '/balance/ghost', headers: AUTH });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'user_not_found', message: expect.any(String) });
  });

  it('returns 404 when debiting an unknown user', async () => {
    const response = await post('/debit', { user_id: 'ghost', amount: 1 });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('user_not_found');
  });

  it('returns 409 when the debit exceeds the balance', async () => {
    await post('/credit', { user_id: 'u1', amount: 100 });
    const response = await post('/debit', { user_id: 'u1', amount: 101 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'insufficient_funds', message: expect.any(String) });
    expect(store.balances.get('u1')).toBe(100);
  });

  it('allows debiting the exact balance down to zero', async () => {
    await post('/credit', { user_id: 'u1', amount: 100 });
    const response = await post('/debit', { user_id: 'u1', amount: 100 });
    expect(response.json()).toEqual({ user_id: 'u1', balance: 0 });
  });

  it('ignores unknown fields', async () => {
    const response = await post('/credit', { user_id: 'u1', amount: 5, currency: 'USD', extra: { a: 1.5 } });
    expect(response.statusCode).toBe(200);
  });

  it('reports health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: AUTH });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('input validation -> 400 invalid_request', () => {
  const invalidBodies: Array<[string, string]> = [
    ['malformed JSON', '{"user_id": "u1", "amount": '],
    ['empty body', ''],
    ['JSON array', '[1,2]'],
    ['JSON string', '"hello"'],
    ['missing user_id', '{"amount": 5}'],
    ['missing amount', '{"user_id": "u1"}'],
    ['decimal amount', '{"user_id": "u1", "amount": 1.5}'],
    ['decimal written as 1.0', '{"user_id": "u1", "amount": 1.0}'],
    ['exponent amount', '{"user_id": "u1", "amount": 1e3}'],
    ['string amount', '{"user_id": "u1", "amount": "100"}'],
    ['zero amount', '{"user_id": "u1", "amount": 0}'],
    ['negative amount', '{"user_id": "u1", "amount": -5}'],
    ['amount too large', '{"user_id": "u1", "amount": 1000000001}'],
    ['huge amount', '{"user_id": "u1", "amount": 99999999999999999999}'],
    ['null amount', '{"user_id": "u1", "amount": null}'],
    ['boolean amount', '{"user_id": "u1", "amount": true}'],
    ['empty user_id', '{"user_id": "", "amount": 5}'],
    ['user_id too long', JSON.stringify({ user_id: 'x'.repeat(65), amount: 5 })],
    ['user_id bad characters', '{"user_id": "u 1", "amount": 5}'],
    ['numeric user_id', '{"user_id": 123, "amount": 5}'],
  ];

  for (const endpoint of ['/credit', '/debit']) {
    for (const [label, payload] of invalidBodies) {
      it(`${endpoint}: ${label}`, async () => {
        const response = await post(endpoint, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_request', message: expect.any(String) });
        expect(store.calls).toBe(0);
      });
    }
  }

  it('rejects a non-JSON content type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/credit',
      headers: { ...AUTH, 'content-type': 'text/plain' },
      payload: 'user_id=u1&amount=5',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it.each(['bad%20id', 'dot.id', 'x'.repeat(65)])('GET /balance/%s -> 400', async (id) => {
    const response = await app.inject({ method: 'GET', url: `/balance/${id}`, headers: AUTH });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });
});

describe('unknown routes', () => {
  it('returns 404 not_found with the standard error shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope', headers: AUTH });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: expect.any(String) });
  });
});
