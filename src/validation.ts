import { invalidRequest } from './errors.js';

export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 1_000_000_000;

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A validated credit or debit request. */
export interface MovementRequest {
  readonly userId: string;
  readonly amount: number;
}

/** Validates a user id from a body field or URL parameter. Throws 400 if invalid. */
export function parseUserId(value: unknown): string {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) {
    throw invalidRequest('user_id must be 1-64 characters of A-Z, a-z, 0-9, _ or -');
  }
  return value;
}

/**
 * Validates an amount. Only a JSON number written as a plain integer reaches
 * here as a `number` (see json.ts), so strings, decimals, booleans and nulls
 * all fail the type check.
 */
export function parseAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_AMOUNT || value > MAX_AMOUNT) {
    throw invalidRequest(`amount must be an integer from ${MIN_AMOUNT} to ${MAX_AMOUNT}`);
  }
  return value;
}

/** Validates a credit/debit body. Unknown fields are ignored. */
export function parseMovement(body: unknown): MovementRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }
  const fields = body as Record<string, unknown>;
  if (!('user_id' in fields)) throw invalidRequest('user_id is required');
  if (!('amount' in fields)) throw invalidRequest('amount is required');
  return { userId: parseUserId(fields['user_id']), amount: parseAmount(fields['amount']) };
}
