/**
 * Strict JSON parsing that remembers how numbers were written.
 *
 * Plain JSON.parse turns `1.0` and `1e3` into the integers 1 and 1000, so a
 * validator looking only at the parsed value would accept them. The contract
 * says decimals must be rejected, so we use the reviver's `context.source`
 * (the raw text of each value, available in Node 21+) and replace any number
 * not written as a plain integer literal with a marker object that validation
 * will reject.
 */

/** Stands in for a JSON number that was not written as a plain integer. */
export class NonIntegerNumber {
  constructor(readonly source: string) {}
}

const INTEGER_LITERAL = /^-?(?:0|[1-9]\d*)$/;

interface ReviverContext {
  readonly source?: string;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: ReviverContext) => {
    if (typeof value === 'number' && context?.source !== undefined && !INTEGER_LITERAL.test(context.source)) {
      return new NonIntegerNumber(context.source);
    }
    return value;
  });
}

/**
 * Fails fast at startup if the runtime cannot expose number source text;
 * without it decimals like `1.0` would silently pass validation.
 */
export function assertJsonSourceTextSupport(): void {
  const probe = parseJson('{"n":1.0}') as { n: unknown };
  if (!(probe.n instanceof NonIntegerNumber)) {
    throw new Error('This Node.js version does not support JSON.parse source text access (Node 21+ required)');
  }
}
