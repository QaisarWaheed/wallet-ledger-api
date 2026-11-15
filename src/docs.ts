/**
 * OpenAPI description of the API, plus an optional Swagger UI at /docs.
 *
 * The route schemas below are DOCUMENTATION ONLY: app.ts disables Fastify's
 * schema validation, because its validator coerces types (it would turn the
 * string "100" into the number 100). Request validation stays in
 * validation.ts and json.ts. Response schemas are still used to serialize
 * responses, which also guarantees no unexpected field ever leaks out.
 *
 * Swagger UI is off by default (ENABLE_DOCS=true turns it on): the brief
 * requires a bearer token on every endpoint, and a browser cannot send one
 * just to open the docs page. When enabled, only the docs pages are public;
 * every API call made from the UI still needs the token (Authorize button).
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance, FastifySchema } from 'fastify';
import { MAX_AMOUNT, MIN_AMOUNT, USER_ID_PATTERN } from './validation.js';

export const DOCS_PREFIX = '/docs';

/** True for the routes that serve the Swagger UI and the OpenAPI document. */
export function isDocsRoute(routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && (routeUrl === DOCS_PREFIX || routeUrl.startsWith(`${DOCS_PREFIX}/`));
}

/**
 * Registers Swagger on the ROOT instance. It must not be wrapped in its own
 * plugin: Fastify encapsulates plugins, and Swagger would then only see the
 * routes declared inside that wrapper (none). Call before declaring routes.
 */
export function registerDocs(app: FastifyInstance): void {
  app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Wallet Ledger API',
        version: '1.0.0',
        description:
          'Credit, debit and read balances. Amounts and balances are integers in minor units ' +
          '(10000 = 100.00). Click **Authorize** and enter the API token (default `recruitment-test-token`).',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ bearerAuth: [] }],
    },
  });
  app.register(swaggerUi, {
    routePrefix: DOCS_PREFIX,
    uiConfig: { tryItOutEnabled: true, displayRequestDuration: true },
  });
}

// ------------------------------------------------------------------ schemas

const userId = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: USER_ID_PATTERN.source,
  description: '1-64 characters: A-Z, a-z, 0-9, _ and -',
  example: 'u123',
} as const;

const balanceResponse = {
  description: 'Balance immediately after the operation',
  type: 'object',
  required: ['user_id', 'balance'],
  properties: {
    user_id: { type: 'string', example: 'u123' },
    balance: { type: 'integer', minimum: 0, example: 21000 },
  },
} as const;

const errorResponse = (description: string, code: string) =>
  ({
    description,
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string', example: code },
      message: { type: 'string' },
    },
  }) as const;

const invalidRequest = errorResponse('Malformed JSON, a missing field, or a field breaking the input rules', 'invalid_request');
const unauthorized = errorResponse('Missing or wrong bearer token', 'unauthorized');
const userNotFound = errorResponse('The user has never been credited', 'user_not_found');

const movementBody = (example: number) =>
  ({
    type: 'object',
    required: ['user_id', 'amount'],
    properties: {
      user_id: userId,
      amount: {
        type: 'integer',
        minimum: MIN_AMOUNT,
        maximum: MAX_AMOUNT,
        description: 'JSON integer in minor units. Decimals (including 1.0), strings, 0 and negatives are rejected.',
        example,
      },
    },
    description: 'Unknown fields are ignored.',
  }) as const;

export const creditSchema: FastifySchema = {
  tags: ['wallet'],
  summary: 'Add money to a user',
  description: 'Adds `amount` to the balance. Creates the user on their first credit.',
  body: movementBody(10000),
  response: { 200: balanceResponse, 400: invalidRequest, 401: unauthorized },
};

export const debitSchema: FastifySchema = {
  tags: ['wallet'],
  summary: 'Take money from a user',
  description: 'Subtracts `amount`. Rejected with 409, writing nothing, if the balance would go below 0.',
  body: movementBody(4000),
  response: {
    200: balanceResponse,
    400: invalidRequest,
    401: unauthorized,
    404: userNotFound,
    409: errorResponse('The debit is larger than the current balance; nothing was written', 'insufficient_funds'),
  },
};

export const balanceSchema: FastifySchema = {
  tags: ['wallet'],
  summary: "Get a user's current balance",
  params: { type: 'object', required: ['user_id'], properties: { user_id: userId } },
  response: {
    200: { ...balanceResponse, description: 'Current balance' },
    400: invalidRequest,
    401: unauthorized,
    404: userNotFound,
  },
};

export const healthSchema: FastifySchema = {
  tags: ['operations'],
  summary: 'Check that the API can reach the database',
  response: {
    200: {
      description: 'Healthy',
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', example: 'ok' } },
    },
    401: unauthorized,
  },
};
