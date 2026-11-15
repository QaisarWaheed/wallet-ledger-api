import { describe, expect, it } from 'vitest';
import { createTokenVerifier } from '../../src/auth.js';

const verify = createTokenVerifier('secret-token');

describe('createTokenVerifier', () => {
  it('accepts the correct bearer token', () => {
    expect(verify('Bearer secret-token')).toBe(true);
  });

  it('treats the scheme name case-insensitively', () => {
    expect(verify('bearer secret-token')).toBe(true);
    expect(verify('BEARER secret-token')).toBe(true);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['wrong token', 'Bearer wrong-token'],
    ['token prefix', 'Bearer secret'],
    ['token with suffix', 'Bearer secret-token-extra'],
    ['token case differs', 'Bearer SECRET-TOKEN'],
    ['wrong scheme', 'Basic secret-token'],
    ['no scheme', 'secret-token'],
    ['scheme only', 'Bearer'],
    ['scheme and space only', 'Bearer '],
    ['two tokens', 'Bearer secret-token other'],
  ])('rejects %s', (_label, header) => {
    expect(verify(header)).toBe(false);
  });

  it('refuses to be built with an empty token', () => {
    expect(() => createTokenVerifier('')).toThrow();
  });
});
