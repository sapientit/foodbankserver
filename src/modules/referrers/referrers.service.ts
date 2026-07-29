import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { Patch } from '../../core/types.ts';
import type {
  AuthorisedReferrer,
  NewAuthorisedReferrer,
  NewReferralReason,
  ReferralReason,
} from '../../db/schema/referrers.ts';
import {
  matchCandidates,
  normaliseMatchValue,
  resolveAuthorisation,
  type ReferrerAuthorisation,
} from './matching.ts';
import type { ReferrersRepository } from './referrers.repository.ts';

export interface ReferrersServiceDeps {
  readonly repository: ReferrersRepository;
  readonly clock: Clock;
}

export function createReferrersService({ repository, clock }: ReferrersServiceDeps) {
  /** One query, then a pure decision. */
  async function checkAuthorisation(email: string): Promise<ReferrerAuthorisation> {
    const { email: normalised, domain } = matchCandidates(email);
    const candidates = await repository.findCandidates(normalised, domain);
    return resolveAuthorisation(email, candidates);
  }

  async function create(input: {
    matchType: 'email' | 'domain';
    matchValue: string;
    organisationName: string;
    notes?: string | null;
  }): Promise<AuthorisedReferrer> {
    const now = clock.nowIso();
    const matchValue = normaliseMatchValue(input.matchType, input.matchValue);

    try {
      return await repository.insert({
        id: crypto.randomUUID(),
        matchType: input.matchType,
        matchValue,
        organisationName: input.organisationName,
        isActive: 1,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // Re-adding an existing rule is an admin mistake, not a server fault —
      // most likely they meant to reactivate the one already there.
      if (
        isUniqueViolation(
          error,
          'authorised_referrers.match_type',
          'authorised_referrers.match_value',
        )
      ) {
        throw new ConflictError('That referrer is already on the list', { cause: error });
      }
      throw error;
    }
  }

  async function update(
    id: string,
    patch: Patch<NewAuthorisedReferrer>,
  ): Promise<AuthorisedReferrer> {
    const updated = await repository.update(id, { ...patch, updatedAt: clock.nowIso() });
    if (updated === undefined) {
      throw new NotFoundError('Authorised referrer not found');
    }
    return updated;
  }

  async function createReason(input: {
    code: string;
    label: string;
    displayOrder?: number;
  }): Promise<ReferralReason> {
    const now = clock.nowIso();

    try {
      return await repository.insertReason({
        id: crypto.randomUUID(),
        code: input.code.trim().toLowerCase(),
        label: input.label,
        displayOrder: input.displayOrder ?? 0,
        isActive: 1,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // Reason codes are the reporting key and are never reused, so a clash
      // must be refused rather than silently merged.
      if (isUniqueViolation(error, 'referral_reasons.code')) {
        throw new ConflictError('That reason code already exists', { cause: error });
      }
      throw error;
    }
  }

  async function updateReason(
    id: string,
    patch: Patch<NewReferralReason>,
  ): Promise<ReferralReason> {
    const updated = await repository.updateReason(id, { ...patch, updatedAt: clock.nowIso() });
    if (updated === undefined) {
      throw new NotFoundError('Referral reason not found');
    }
    return updated;
  }

  return {
    checkAuthorisation,
    list: () => repository.list(),
    create,
    update,
    listReasons: (activeOnly: boolean) => repository.listReasons(activeOnly),
    createReason,
    updateReason,
  };
}

export type ReferrersService = ReturnType<typeof createReferrersService>;
