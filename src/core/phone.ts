/**
 * UK phone number normalisation. Pure, no I/O.
 *
 * `referrals.refereePhone` is free text a referrer typed. `modules/referrals`
 * uses this to compute a settled form of the number for repeat-referral
 * matching, and `modules/sms` uses it because TheSMSWorks needs E.164
 * (`+447700900123`) and its webhook has to match an inbound number back to
 * whatever shape the referral holds it in. Both directions, and both callers,
 * go through the same normaliser, and two numbers are "the same" exactly when
 * they normalise to the same string.
 *
 * Only UK numbers are handled, because that is what the referral form collects
 * and what TheSMSWorks sends to. Anything else — a different country code, too
 * few or too many digits, letters — normalises to `null` rather than a guess.
 */

const UK_E164_PATTERN = /^\+44\d{10}$/;

/**
 * Normalises a UK phone number to E.164, or `null` if it cannot be.
 *
 * Handles the four shapes a referrer or the provider might use:
 * `07700 900123`, `+447700900123`, `447700900123`, `07700900123` — spaces,
 * hyphens and parentheses are stripped first, so `07700 900 123` and
 * `(07700) 900123` normalise the same way.
 */
export function normalisePhone(input: string): string | null {
  const stripped = input.replace(/[\s()-]/g, '');
  if (stripped === '') return null;

  let candidate: string;
  if (stripped.startsWith('+44')) {
    candidate = stripped;
  } else if (stripped.startsWith('0044')) {
    candidate = `+${stripped.slice(2)}`;
  } else if (stripped.startsWith('44')) {
    candidate = `+${stripped}`;
  } else if (stripped.startsWith('0')) {
    candidate = `+44${stripped.slice(1)}`;
  } else {
    // A leading '+' for some other country code, or anything unrecognised.
    return null;
  }

  return UK_E164_PATTERN.test(candidate) ? candidate : null;
}

/** True when both numbers normalise to the same E.164 number. */
export function phonesMatch(a: string, b: string): boolean {
  const normalisedA = normalisePhone(a);
  if (normalisedA === null) return false;
  return normalisedA === normalisePhone(b);
}
