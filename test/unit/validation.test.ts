import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/errors.js';
import { parseJson } from '../../src/json.js';
import { MAX_AMOUNT, parseAmount, parseMovement, parseUserId } from '../../src/validation.js';

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(400);
    expect((error as ApiError).code).toBe('invalid_request');
    return;
  }
  throw new Error('Expected an invalid_request error');
}

describe('parseUserId', () => {
  it.each(['u', 'u123', 'A_b-9', 'x'.repeat(64)])('accepts %s', (id) => {
    expect(parseUserId(id)).toBe(id);
  });

  it.each(['', 'x'.repeat(65), 'has space', 'semi;colon', 'dot.dot', 'üser', 'a\n', 123, null, undefined])(
    'rejects %j',
    (id) => expectInvalid(() => parseUserId(id)),
  );
});

describe('parseAmount', () => {
  it.each([1, 10000, MAX_AMOUNT])('accepts %d', (amount) => {
    expect(parseAmount(amount)).toBe(amount);
  });

  it.each([0, -1, MAX_AMOUNT + 1, 1.5, Number.NaN, '100', true, null, undefined, {}])('rejects %j', (amount) =>
    expectInvalid(() => parseAmount(amount)),
  );

  it.each(['1.0', '1e3', '100.00'])('rejects the JSON literal %s', (literal) => {
    const body = parseJson(`{"amount": ${literal}}`) as { amount: unknown };
    expectInvalid(() => parseAmount(body.amount));
  });
});

describe('parseMovement', () => {
  it('returns the validated fields and ignores unknown ones', () => {
    expect(parseMovement({ user_id: 'u1', amount: 5, note: 'ignored' })).toEqual({ userId: 'u1', amount: 5 });
  });

  it.each([null, [], 'text', 42, {}, { user_id: 'u1' }, { amount: 5 }])('rejects body %j', (body) =>
    expectInvalid(() => parseMovement(body)),
  );
});
