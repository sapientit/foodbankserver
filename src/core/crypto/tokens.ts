/**
 * Secret minting and hashing.
 *
 * Used for referral edit keys, refresh tokens and stock-take volunteer codes.
 * All follow the same rule: the plaintext is returned to the client exactly
 * once and never stored — only its SHA-256 hash goes in the database, so a
 * database dump yields nothing usable.
 *
 * Plain SHA-256 rather than a password KDF is correct here: these are hundreds
 * of bits of true randomness, not user-chosen secrets, so there is nothing to
 * brute force and key stretching would only burn Worker CPU.
 */

const TOKEN_BYTES = 32;

/**
 * Crockford base32 — no I, L, O or U, so nothing a volunteer copies off a slip
 * of paper is ambiguous. `normaliseVolunteerCode` folds the few confusions
 * that remain (a written I for 1, O for 0) back before hashing.
 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const VOLUNTEER_CODE_BYTES = 10;

/** A fresh 256-bit secret, base64url-encoded. Return to the client once, never log. */
export function mintSecret(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * A fresh stock-take volunteer code: 80 bits, grouped `XXXX-XXXX-XXXX-XXXX`.
 *
 * Shorter than `mintSecret` on purpose — it is typed in by hand, not pasted —
 * and 80 bits is still far past any feasible online guessing, with only the
 * hash stored so there is nothing to attack offline. Return to the client
 * once, never log.
 */
export function mintVolunteerCode(): string {
  const bytes = new Uint8Array(VOLUNTEER_CODE_BYTES);
  crypto.getRandomValues(bytes);

  let accumulator = 0;
  let bits = 0;
  let code = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += CROCKFORD_ALPHABET.charAt((accumulator >>> bits) & 0x1f);
    }
    accumulator &= (1 << bits) - 1;
  }

  return code.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Folds a presented code to the exact form `mintVolunteerCode` hashed: upper
 * case, no separators, and the handful of characters a person still confuses
 * mapped to their Crockford meaning. Both storage and lookup hash this, so the
 * code the volunteer types need only be close.
 */
export function normaliseVolunteerCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0')
    .replaceAll('U', 'V');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
