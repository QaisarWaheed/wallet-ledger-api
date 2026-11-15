import { describe, expect, it } from 'vitest';
import { assertJsonSourceTextSupport, NonIntegerNumber, parseJson } from '../../src/json.js';

describe('parseJson', () => {
  it('keeps plain integer literals as numbers', () => {
    expect(parseJson('{"amount": 100, "neg": -5, "zero": 0}')).toEqual({ amount: 100, neg: -5, zero: 0 });
  });

  it.each(['1.0', '1.5', '1e3', '1E3', '-0.0', '10e-1'])('marks %s as a non-integer literal', (literal) => {
    const parsed = parseJson(`{"amount": ${literal}}`) as { amount: unknown };
    expect(parsed.amount).toBeInstanceOf(NonIntegerNumber);
    expect((parsed.amount as NonIntegerNumber).source).toBe(literal);
  });

  it('leaves strings, booleans and null untouched', () => {
    expect(parseJson('{"a": "1", "b": true, "c": null}')).toEqual({ a: '1', b: true, c: null });
  });

  it('throws on malformed JSON', () => {
    expect(() => parseJson('{"amount": ')).toThrow(SyntaxError);
  });

  it('is supported by the current runtime', () => {
    expect(() => assertJsonSourceTextSupport()).not.toThrow();
  });
});
