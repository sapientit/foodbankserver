import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import type { NewReferral } from '../../db/schema/referrals.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import { normalisePhone } from '../../core/phone.ts';
import { normalisePostcode } from '../referrals/matching.ts';
import type { ReferralsRepository } from '../referrals/referrals.repository.ts';
import type { ReferrersRepository } from '../referrers/referrers.repository.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { ReferralImport } from '../../db/schema/dev-test-imports.ts';
import type { DevTestImportsRepository } from './dev-test-imports.repository.ts';
import type { ReferralImportRequest } from './dev-test.schema.ts';

/**
 * Bulk-loads prepared, anonymised referral scenarios for the client's own
 * dev/test automation — never a real referral source. `dev-test.routes.ts`
 * registers the route only outside production; nothing here re-checks that,
 * because a service has no business knowing about environments — that gate
 * is a build-time decision belonging to the route.
 *
 * ## What this deliberately does not do
 *
 * Three gates a real submission enforces are skipped here, all settled with
 * Pete on 2026-09-11:
 *
 * - **Referrer authorisation.** A real submission's status depends on
 *   whether `referrerEmail` matches the authorised-referrer list. An import
 *   always creates `active` referrals; `checkAuthorisation` never runs and
 *   `authorisedReferrerId` is always `null` — the same as an administrator's
 *   `copy()`, which records no authorisation decision either.
 * - **The 16:00-the-day-before booking cutoff.** A test run must be able to
 *   target a session happening later today or tomorrow.
 * - Session-open and capacity (including delivery capacity) still apply —
 *   see below — because those are what "the session is open and has room"
 *   means regardless of who is asking.
 * - **No `audit_events` row per referral**, unlike `submit()` and `copy()`,
 *   which both write one alongside the referral insert. A deliberate
 *   omission, not an oversight: `referral_imports` itself is the accountability
 *   record for the whole call (`createdByUserId`, `importKey`, `createdAt`),
 *   and doubling the batch's statement count would roughly halve
 *   `MAX_IMPORT_REFERRALS` before the query-budget note below stopped holding.
 *
 * ## Capacity, checked for the whole batch at once
 *
 * A real submission checks one place against one read of `booked` — see
 * `referrals.service.ts`'s `assertSessionAccepts`, which accepts the race
 * between two concurrent submissions as harmless because the overshoot such a
 * race can cause is bounded by a handful of referrals. An import instead adds
 * up to `referrals.length` places in one call, so the check is against
 * `booked + referrals.length`, read once before the batch is composed. The
 * same *class* of race is possible here too, but **not the same magnitude**:
 * two imports racing the same session could each carry up to
 * `MAX_IMPORT_REFERRALS`, so the possible overshoot is larger than a real
 * submission's. Accepted anyway for an admin-only dev/test tool — call this
 * out again if this capacity check is ever reused somewhere the caller is not
 * trusted the way an administrator running test fixtures is.
 *
 * ## Atomicity and idempotency
 *
 * D1 has no interactive transaction, so both come from the same batch:
 * **`db.batch([...referral inserts, one referral_imports insert])`** is one
 * write. If any statement in it fails, none of it lands — "all rows load or
 * none do" is just what a batch already guarantees, not a separate mechanism.
 *
 * `referral_imports.import_key` is a primary key, so a second call with the
 * same key fails that one statement with a unique violation and rolls the
 * whole batch back — no duplicate referrals are created. The service catches
 * that violation, reads the row back, and either replays its stored result
 * (the request matches) or refuses with a `409` (it does not) — see
 * `replayOrConflict`. The up-front check for an existing row before composing
 * the batch is the fast path for the ordinary case, a genuine repeat call;
 * the unique index is what makes it correct even when two calls race.
 */
export interface DevTestImportsServiceDeps {
  readonly db: Database;
  readonly repository: DevTestImportsRepository;
  readonly referrals: ReferralsRepository;
  readonly sessions: SessionsRepository;
  readonly referrers: ReferrersRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface ImportedReferral {
  readonly sourceIndex: number;
  readonly referralId: string;
}

export interface ImportResult {
  readonly sessionId: string;
  readonly importKey: string;
  readonly referrals: readonly ImportedReferral[];
}

export function createDevTestImportsService(deps: DevTestImportsServiceDeps) {
  const { db, repository, referrals, sessions, referrers, clock, logger } = deps;

  async function importReferrals(
    input: ReferralImportRequest,
    actor: Actor,
  ): Promise<ImportResult> {
    const requestHash = await hashRequest(input);

    // The fast path for an ordinary repeat call. Racing this against another
    // call for the same key is still safe — see the unique-violation catch
    // below — this just saves composing and sending a batch that would only
    // fail anyway.
    const existing = await repository.findByImportKey(input.importKey);
    if (existing !== undefined) {
      return replayOrConflict(existing, requestHash);
    }

    const session = await sessions.findById(input.sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }
    if (session.status === 'cancelled') {
      throw new ConflictError('That session has been cancelled');
    }
    if (session.status === 'confirmed') {
      throw new ConflictError('That session has already been confirmed');
    }

    const reason = await referrers.findActiveReasonById(input.reasonId);
    if (reason === undefined) {
      throw new UnprocessableError('That reason for referral is no longer offered');
    }

    const booked = await referrals.countHoldingAPlace(input.sessionId);
    if (booked + input.referrals.length > session.capacity) {
      throw new ConflictError('That session does not have capacity for this many referrals', {
        details: { capacity: session.capacity, booked, requested: input.referrals.length },
      });
    }

    const deliveryCount = input.referrals.filter(
      (referral) => referral.collectionMethod === 'delivery',
    ).length;
    if (deliveryCount > 0) {
      const deliveryBooked = await referrals.countDeliveriesHoldingAPlace(input.sessionId);
      if (deliveryBooked + deliveryCount > session.deliveryCapacity) {
        throw new ConflictError(
          'That session does not have delivery capacity for this many deliveries',
          {
            details: {
              deliveryCapacity: session.deliveryCapacity,
              deliveryBooked,
              requested: deliveryCount,
            },
          },
        );
      }
    }

    const now = clock.nowIso();
    const created = input.referrals.map((referral, index) => {
      const referralId = crypto.randomUUID();
      const refereePhone = referral.refereePhone ?? null;

      const row: NewReferral = {
        id: referralId,
        sessionId: input.sessionId,
        // Forced active — the referrer-authorisation decision never runs.
        // See the class doc comment.
        status: 'active',
        referredAt: now,
        cancelledAt: null,
        cancelledReason: null,
        reviewComment: null,
        reviewedByUserId: null,
        referrerOrganisation: referral.referrerOrganisation,
        authorisedReferrerId: null,
        adults: referral.adults,
        children: referral.children,
        isDelivery: referral.collectionMethod === 'delivery' ? 1 : 0,
        collectionMethod: referral.collectionMethod,
        reasonId: input.reasonId,
        needsFuelHelp: referral.needsFuelHelp ? 1 : 0,
        referrerName: referral.referrerName,
        referrerEmail: referral.referrerEmail.trim().toLowerCase(),
        referrerPhone: referral.referrerPhone,
        refereeFirstName: referral.refereeFirstName,
        refereeSurname: referral.refereeSurname,
        refereeDateOfBirth: referral.refereeDateOfBirth,
        refereeAddress: referral.refereeAddress,
        refereePostcode: referral.refereePostcode,
        refereePhone,
        refereePostcodeNormalised: normalisePostcode(referral.refereePostcode),
        refereePhoneNormalised: refereePhone === null ? null : normalisePhone(refereePhone),
        answersJson: JSON.stringify(referral.answers),
        adminInfo: null,
        smsReminderSentAt: null,
        piiPurgedAt: null,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      };

      // 1-based, matching the example in the requirement — the position of
      // this scenario in the request's own `referrals` array.
      return { sourceIndex: index + 1, referralId, row };
    });

    const result: ImportResult = {
      sessionId: input.sessionId,
      importKey: input.importKey,
      referrals: created.map(({ sourceIndex, referralId }) => ({ sourceIndex, referralId })),
    };

    const statements = [
      repository.buildInsertImportRecord({
        importKey: input.importKey,
        sessionId: input.sessionId,
        reasonId: input.reasonId,
        requestHash,
        resultJson: JSON.stringify(result),
        createdByUserId: actor.userId,
        createdAt: now,
      }),
      ...created.map(({ row }) => referrals.buildInsertReferral(row)),
    ];

    try {
      // Non-empty by construction: the array above always holds at least the
      // tracking-row insert, which `db.batch` requires — the same cast
      // `materialise-sessions.ts` uses for the same reason.
      await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    } catch (error) {
      if (isUniqueViolation(error, 'referral_imports.import_key')) {
        const raced = await repository.findByImportKey(input.importKey);
        if (raced !== undefined) {
          return replayOrConflict(raced, requestHash);
        }
      }
      throw error;
    }

    // Counts and identifiers only — never a name, address or answer. See
    // `.claude/rules/pii-security.md`.
    logger.info('dev-test referrals imported', {
      sessionId: input.sessionId,
      count: created.length,
      userId: actor.userId,
    });

    return result;
  }

  function replayOrConflict(existing: ReferralImport, requestHash: string): ImportResult {
    if (existing.requestHash !== requestHash) {
      throw new ConflictError('That importKey was already used for a different import', {
        details: { importKey: existing.importKey },
      });
    }
    return JSON.parse(existing.resultJson) as ImportResult;
  }

  return { importReferrals };
}

export type DevTestImportsService = ReturnType<typeof createDevTestImportsService>;

/**
 * SHA-256 (hex) of the validated request, so a repeat call under the same
 * `importKey` can be told from a reused key sent with a different body.
 *
 * Hashes the **parsed** Zod output, not the raw request text, and
 * canonicalises it first — sorting every plain object's keys, recursively —
 * rather than relying on Zod's own key order. That is enough for every
 * fixed-shape field (`z.object` always emits its shape's own keys in schema
 * order, whatever order the client sent them in), but `answers` is a
 * `z.record` (`referrals.schema.ts`), and Zod does not reorder a record's
 * keys — it keeps whatever order the input arrived in. Two calls carrying
 * semantically identical `answers` built by different code (a literal versus
 * `Object.fromEntries`, say) can arrive with different key order, and without
 * this step they would hash differently and a genuine replay would be wrongly
 * refused as "already used for a different import" — the one failure this
 * function exists to prevent. Array order is left alone: it is what fixes
 * `sourceIndex` to a scenario, and reordering `referrals` is a different
 * request, not the same one reformatted.
 */
async function hashRequest(input: ReferralImportRequest): Promise<string> {
  const canonical = JSON.stringify(
    canonicalise({
      sessionId: input.sessionId,
      reasonId: input.reasonId,
      referrals: input.referrals,
    }),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sorts every plain object's keys, recursively, leaving arrays and
 * primitives as they are. See `hashRequest` for why this has to be a
 * separate pass rather than trusting Zod's own output order.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const sorted: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      sorted[key] = canonicalise((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
