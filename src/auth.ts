import { createHash, timingSafeEqual } from 'node:crypto';

/** Returns true when the Authorization header carries the expected bearer token. */
export type TokenVerifier = (authorizationHeader: string | undefined) => boolean;

// Auth scheme names are case-insensitive (RFC 9110), the token itself is not.
const BEARER_PATTERN = /^Bearer +(\S+) *$/i;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Builds a constant-time token check.
 *
 * Both tokens are hashed first so the compared buffers always have the same
 * length: timingSafeEqual throws on a length mismatch, and returning early
 * on length would leak the token length through timing.
 */
export function createTokenVerifier(expectedToken: string): TokenVerifier {
  if (expectedToken.length === 0) throw new Error('API token must not be empty');
  const expectedDigest = sha256(expectedToken);

  return (authorizationHeader) => {
    if (authorizationHeader === undefined) return false;
    const match = BEARER_PATTERN.exec(authorizationHeader);
    const presented = match?.[1];
    if (presented === undefined) return false;
    return timingSafeEqual(sha256(presented), expectedDigest);
  };
}
