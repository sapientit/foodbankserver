/**
 * Deciding whether an email address is allowed to make a referral.
 *
 * Pure — the repository fetches candidate rows, this decides. Keeping the
 * precedence rule out of SQL means it can be tested exhaustively without a
 * database, which matters because getting it wrong either turns away a real
 * referrer or lets a blocked one through.
 */

export interface ReferrerCandidate {
  readonly id: string;
  readonly matchType: 'email' | 'domain';
  readonly matchValue: string;
  readonly organisationName: string;
  readonly isActive: number;
}

export interface ReferrerAuthorisation {
  readonly authorised: boolean;
  readonly organisationName: string | null;
  readonly matchedId: string | null;
}

const UNAUTHORISED: ReferrerAuthorisation = {
  authorised: false,
  organisationName: null,
  matchedId: null,
};

/** Normalises an address for matching. Storage uses the same form. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The domain part, or undefined if the address has no usable one. */
export function domainOf(email: string): string | undefined {
  const at = normaliseEmail(email).lastIndexOf('@');
  if (at < 1) return undefined;

  const domain = normaliseEmail(email).slice(at + 1);
  return domain === '' ? undefined : domain;
}

/**
 * The values an address could be authorised by: the address itself, and its
 * domain. Passed to the repository so the lookup is one query, not two.
 */
export function matchCandidates(email: string): { email: string; domain: string | undefined } {
  return { email: normaliseEmail(email), domain: domainOf(email) };
}

/**
 * Applies the precedence rule to whatever the repository found.
 *
 * An exact-email row always wins over a domain row — **including when it is
 * inactive**. That is what makes deactivating one address a way to block a
 * single person inside an otherwise authorised organisation, which is the
 * behaviour a food bank actually needs when someone leaves a council team or
 * misuses the service. Falling through to the domain in that case would
 * silently undo the block.
 */
export function resolveAuthorisation(
  email: string,
  candidates: readonly ReferrerCandidate[],
): ReferrerAuthorisation {
  const normalised = normaliseEmail(email);
  const domain = domainOf(email);

  const exact = candidates.find(
    (row) => row.matchType === 'email' && row.matchValue === normalised,
  );
  if (exact !== undefined) {
    return exact.isActive === 1
      ? { authorised: true, organisationName: exact.organisationName, matchedId: exact.id }
      : UNAUTHORISED;
  }

  if (domain === undefined) return UNAUTHORISED;

  const byDomain = candidates.find(
    (row) => row.matchType === 'domain' && row.matchValue === domain,
  );
  if (byDomain?.isActive !== 1) {
    return UNAUTHORISED;
  }

  return {
    authorised: true,
    organisationName: byDomain.organisationName,
    matchedId: byDomain.id,
  };
}

/** Strips a leading `*@`, which is how the UI writes a domain rule. */
export function normaliseMatchValue(matchType: 'email' | 'domain', value: string): string {
  const trimmed = normaliseEmail(value);
  if (matchType === 'domain') {
    return trimmed.startsWith('*@') ? trimmed.slice(2) : trimmed.replace(/^@/, '');
  }
  return trimmed;
}
