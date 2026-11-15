import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createTokenVerifier } from '../../src/auth.js';
import { WalletService } from '../../src/walletService.js';
import { InMemoryLedgerStore } from './inMemoryLedgerStore.js';

const TOKEN = 'docs-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance | undefined;

async function start(enableDocs: boolean): Promise<FastifyInstance> {
  app = buildApp({
    verifyToken: createTokenVerifier(TOKEN),
    wallet: new WalletService(new InMemoryLedgerStore()),
    logLevel: 'silent',
    enableDocs,
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('Swagger docs disabled (default)', () => {
  it.each(['/docs', '/docs/', '/docs/json'])('%s requires the token like any other route', async (url) => {
    const server = await start(false);
    const response = await server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it('with a token, /docs simply does not exist', async () => {
    const server = await start(false);
    const response = await server.inject({ method: 'GET', url: '/docs', headers: AUTH });
    expect(response.statusCode).toBe(404);
  });
});

describe('Swagger docs enabled', () => {
  it('serves the UI without a token', async () => {
    const server = await start(true);
    const response = await server.inject({ method: 'GET', url: '/docs/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('serves an OpenAPI document describing every endpoint with bearer auth', async () => {
    const server = await start(true);
    const response = await server.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(Object.keys(spec.paths).sort()).toEqual(['/balance/{user_id}', '/credit', '/debit', '/health']);
    expect(spec.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(spec.paths['/debit'].post.responses).sort()).toEqual(['200', '400', '401', '404', '409']);
  });

  it('still requires the token on every API endpoint', async () => {
    const server = await start(true);
    const requests = [
      { method: 'POST' as const, url: '/credit', payload: { user_id: 'u1', amount: 1 } },
      { method: 'POST' as const, url: '/debit', payload: { user_id: 'u1', amount: 1 } },
      { method: 'GET' as const, url: '/balance/u1' },
      { method: 'GET' as const, url: '/health' },
      { method: 'GET' as const, url: '/not-a-route' },
    ];
    for (const request of requests) {
      expect((await server.inject(request)).statusCode, request.url).toBe(401);
    }
  });

  it('cannot be used to bypass auth with path tricks', async () => {
    const server = await start(true);
    for (const url of ['/docs/../credit', '/docs/..%2fcredit', '/docs%2f../balance/u1']) {
      const response = await server.inject({ method: 'POST', url, payload: { user_id: 'u1', amount: 1 } });
      expect(response.statusCode, url).not.toBe(200);
    }
  });

  it('documentation schemas do not weaken validation: "100" as a string is still rejected', async () => {
    const server = await start(true);
    const response = await server.inject({
      method: 'POST',
      url: '/credit',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '{"user_id": "u1", "amount": "100"}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('serializes responses exactly as before', async () => {
    const server = await start(true);
    const response = await server.inject({ method: 'POST', url: '/credit', headers: AUTH, payload: { user_id: 'u1', amount: 25000 } });
    expect(response.json()).toEqual({ user_id: 'u1', balance: 25000 });
  });
});
