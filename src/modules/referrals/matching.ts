/**
 * Repeat-referral matching. Pure, no I/O.
 *
 * `INITIAL_SPEC1.txt`, `#Reviewing a referral`: matching is on date of birth,
 * postcode and phone number, any one sufficient, and each match reports which
 * of the three it hit — a match on all three is almost certainly the same
 * household, a match on postcode alone may be nothing more than two families
 * in the same block of flats, a hostel or a refuge. Names are deliberately
 * never matched on: different people from the same household are referred at
 * different times, and the same name is typed differently by different
 * referrers.
 */

export const MATCH_KINDS = ['date_of_birth', 'postcode', 'phone'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/**
 * The three fields matching runs on, already in their settled (normalised)
 * form. `dateOfBirth` needs no normalisation — `referrals.schema.ts` enforces
 * `YYYY-MM-DD` (`isPlainDate`) on every write, so two dates of birth are equal
 * exactly when the strings are equal. Adding a normaliser here would just be
 * somewhere else for the format to quietly drift from the schema.
 */
export interface MatchableFields {
  readonly dateOfBirth: string | null;
  readonly postcodeNormalised: string | null;
  readonly phoneNormalised: string | null;
}

const POSTCODE_PATTERN = /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/;

/**
 * Settles a postcode into its matching form: uppercase, every whitespace
 * character removed (`\s`, which covers tab and non-breaking space), kept
 * only if the result looks like a UK postcode. Anything else — including
 * `null` in — normalises to `null`.
 *
 * This is **not validation**. A postcode the rule cannot make sense of does
 * not stop the referral: it is taken and stored exactly as the referrer typed
 * it, and simply never matched on. The food bank would rather look at a
 * referral with an odd postcode than turn a household away over the way an
 * address was written down.
 *
 * The rule is written down once but implemented twice: the client repo
 * normalises the same way (and shows a display form the server never needs),
 * and the rule is restated in `API.md` for that reason. Changing it here
 * alone silently breaks the pair.
 */
export function normalisePostcode(input: string | null): string | null {
  if (input === null) return null;
  const settled = input.toUpperCase().replace(/\s/g, '');
  return POSTCODE_PATTERN.test(settled) ? settled : null;
}

/**
 * The kinds of match `a` and `b` agree on, in `MATCH_KINDS` order.
 *
 * A field matches only when **both sides are non-null and equal**. A `null`
 * never matches a `null`: two households that both have no phone number have
 * nothing in common, that is an absence rather than a shared detail, and the
 * same holds for a postcode neither side's value could be made sense of.
 * Only a value the food bank actually holds and understands can match
 * another — treating two absences as a match would silently group together
 * every household with no phone number.
 */
export function matchKinds(a: MatchableFields, b: MatchableFields): MatchKind[] {
  const kinds: MatchKind[] = [];
  if (a.dateOfBirth !== null && a.dateOfBirth === b.dateOfBirth) {
    kinds.push('date_of_birth');
  }
  if (a.postcodeNormalised !== null && a.postcodeNormalised === b.postcodeNormalised) {
    kinds.push('postcode');
  }
  if (a.phoneNormalised !== null && a.phoneNormalised === b.phoneNormalised) {
    kinds.push('phone');
  }
  return kinds;
}

/**
 * True when at least one of the three settled fields is present.
 *
 * Lets the caller skip the repeat-referral query entirely for a referral with
 * nothing matchable — a real case, since postcode and phone can both be
 * unrecognisable and normalise to `null`.
 */
export function hasAnythingToMatchOn(fields: MatchableFields): boolean {
  return (
    fields.dateOfBirth !== null ||
    fields.postcodeNormalised !== null ||
    fields.phoneNormalised !== null
  );
}
