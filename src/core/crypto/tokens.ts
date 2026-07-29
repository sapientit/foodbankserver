/**
 * Secret minting and hashing.
 *
 * Used for referral edit keys and refresh tokens. Both follow the same rule:
 * the plaintext is returned to the client exactly once and never stored — only
 * its SHA-256 hash goes in the database, so a database dump yields nothing
 * usable.
 *
 * Plain SHA-256 rather than a password KDF is correct here: these are 256 bits
 * of true randomness, not user-chosen secrets, so there is nothing to brute
 * force and key stretching would only burn Worker CPU.
 */

const TOKEN_BYTES = 32;

/** A fresh 256-bit secret, base64url-encoded. Return to the client once, never log. */
export function mintSecret(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
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
