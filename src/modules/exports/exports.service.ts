import { EXTRACT_CLAIM_TTL_MINUTES } from '../../config/constants.ts';
import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { ReferralsService } from '../referrals/referrals.service.ts';
import type { ReferrersService } from '../referrers/referrers.service.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import { toExtractRow, type ExtractRow } from './exports.mapper.ts';

/**
 * Extracting confirmed sessions to the charity's Google spreadsheet.
 *
 * `INITIAL_SPEC1.txt`, `#Sending referrals to the spreadsheet`.
 *
 * ## The server never talks to Google
 *
 * The administrator's browser holds the Google credential, obtained from
 * their own Google account after they have agreed that this might take a
 * while. It reads a session's referrals from here, writes them to the
 * spreadsheet itself, and only then tells this service the write succeeded.
 * **No Google token reaches this server, is stored by it, or is used by it,
 * and nothing here calls a Google API.** A service-account design that did
 * all of that was built and then deliberately replaced; do not reintroduce
 * it.
 *
 * What is left here is therefore small: hand out the configuration the
 * browser needs, hand out one session at a time without handing the same one
 * to two people, and record that a session has been written.
 *
 * ## The seam that cannot be made atomic
 *
 * The spreadsheet and this database cannot be one transaction, and no design
 * makes them one. If the browser's write succeeds and its completion call
 * then fails, the session stays unextracted and a later batch sends it again
 * — a duplicate. That is the way round it should fail: a duplicate carries
 * `referralId` and can be found and deleted, while a household that quietly
 * never arrived cannot be found at all.
 *
 * It follows that **completing must never be what triggers a write**, and
 * that the browser must not automatically retry a timed-out Google write —
 * it may have succeeded. Completion against this server may be retried
 * freely; that is a different thing and is safe by design, see `complete`.
 */

export interface ExportServiceDeps {
  readonly sessions: SessionsRepository;
  readonly referralsService: ReferralsService;
  readonly referrersService: ReferrersService;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly google: ExtractConfig | undefined;
}

/** The deployment's spreadsheet and OAuth client. Neither is a secret. */
export interface ExtractConfig {
  readonly spreadsheetId: string;
  readonly googleClientId: string;
}

export interface ExtractConfigResponse extends Partial<ExtractConfig> {
  /** False when the deployment has no spreadsheet configured; nothing can run. */
  readonly configured: boolean;
}

export interface ExtractProgress {
  /** Confirmed sessions not yet extracted, including any currently claimed. */
  readonly remaining: number;
  /** Confirmed sessions already extracted. Progress, for the screen. */
  readonly extracted: number;
}

export interface ExtractClaim {
  readonly claimId: string;
  readonly expiresAt: string;
  /**
   * For completing the claim and for reconciling a duplicate — **not** a
   * spreadsheet column. A UUID in a spreadsheet helps nobody, which is the
   * same reason `ExtractRow` carries the reason's label rather than its id.
   */
  readonly sessionId: string;
  readonly sessionDate: string;
  /** The session's location, which is what the spreadsheet's session column holds. */
  readonly sessionLocation: string;
  readonly rows: readonly ExtractRow[];
}

export interface ClaimResponse extends ExtractProgress {
  /** `null` when nothing is waiting, or everything waiting is claimed. */
  readonly claim: ExtractClaim | null;
}

export interface CompleteResponse extends ExtractProgress {
  readonly sessionId: string;
  readonly extractedAt: string;
  /** True when this claim had already completed and this call changed nothing. */
  readonly alreadyExtracted: boolean;
}

/**
 * The two configured values, or `undefined` unless both are present.
 *
 * All-or-nothing on purpose: a spreadsheet id with no OAuth client, or the
 * reverse, is a half-configured deployment, and the useful thing to tell an
 * administrator is "this is not set up" rather than letting the browser fail
 * at Google with something they cannot act on.
 */
export function extractConfig(config: {
  readonly googleSpreadsheetId: string | undefined;
  readonly googleOauthClientId: string | undefined;
}): ExtractConfig | undefined {
  const { googleSpreadsheetId, googleOauthClientId } = config;
  if (googleSpreadsheetId === undefined || googleOauthClientId === undefined) return undefined;
  return { spreadsheetId: googleSpreadsheetId, googleClientId: googleOauthClientId };
}

export function createExportsService(deps: ExportServiceDeps) {
  const { sessions, referralsService, referrersService, clock, logger, google } = deps;

  /**
   * What the browser needs before it can start: which spreadsheet, and which
   * OAuth client to ask the administrator's Google account for consent
   * against.
   *
   * Neither value is a secret — the OAuth client id is public by design and
   * the spreadsheet id is useless without access to the spreadsheet — but
   * both are only handed to an administrator, because nobody else has any
   * business starting an extract.
   */
  function config(): ExtractConfigResponse {
    if (google === undefined) return { configured: false };
    return { configured: true, ...google };
  }

  function requireConfigured(): void {
    if (google === undefined) {
      throw new UnprocessableError(
        'The spreadsheet extract is not configured. Set the spreadsheet id and the Google OAuth client id.',
      );
    }
  }

  /**
   * Reserves the next session and hands back everything needed to write it.
   *
   * One session at a time, oldest first, reserved **atomically** — see
   * `claimNextForExtract`. Two administrators working the queue together get
   * different sessions rather than the same one twice.
   *
   * The referrals come back with the claim rather than behind a second call.
   * The browser needs the claim and the rows together and can do nothing with
   * one without the other, so a second round trip would only widen the window
   * in which the claim can expire before its rows have even arrived.
   *
   * The reason list is loaded **once per claim**, not per referral: a reason
   * id is a UUID nobody reading a spreadsheet can use, and resolving one per
   * row would be a query per row. Retired reasons are included, since a
   * referral that cited one keeps it.
   */
  async function claimNext(actor: Actor): Promise<ClaimResponse> {
    requireConfigured();

    const now = clock.nowIso();
    const session = await sessions.claimNextForExtract({
      claimId: crypto.randomUUID(),
      userId: actor.userId,
      expiresAt: addMinutes(now, EXTRACT_CLAIM_TTL_MINUTES),
      now,
    });

    if (session === undefined) {
      // Nothing to do. Not an error: this is how a batch ends.
      return { claim: null, ...(await sessions.extractProgress()) };
    }

    // Every referral on the session, whatever its status — the cancelled and
    // rejected ones included. A referral that was turned away still happened
    // and the spreadsheet is the record of what happened. The actor is the
    // administrator who started the extract, so this reads through the same
    // visibility rules as any other admin read rather than round the back.
    const referrals = await referralsService.listReferrals({ sessionId: session.id }, actor);

    const reasons = await referrersService.listReasons(false);
    const labelOf = new Map(reasons.map((reason) => [reason.id, reason.label]));

    const rows = referrals.map((referral) =>
      toExtractRow(referral, labelOf.get(referral.reasonId) ?? null),
    );

    // Counts and identifiers only. `LogContext` cannot carry a name or an
    // address by construction, which is what makes this safe rather than
    // remembered.
    logger.info('session claimed for extract', { sessionId: session.id, count: rows.length });

    // The claim columns are written by the statement that returned this row,
    // so they cannot be null here. Failing loudly beats handing the browser a
    // blank claim id it would present back and be told never existed.
    const { extractClaimId, extractClaimExpiresAt } = session;
    if (extractClaimId === null || extractClaimExpiresAt === null) {
      throw new Error('Claimed a session without a claim on it');
    }

    return {
      claim: {
        claimId: extractClaimId,
        expiresAt: extractClaimExpiresAt,
        sessionId: session.id,
        sessionDate: session.sessionDate,
        sessionLocation: session.location,
        rows,
      },
      ...(await sessions.extractProgress()),
    };
  }

  /**
   * Marks a claimed session extracted, after the browser has written it.
   *
   * **This never writes to Google and never can.** It is the browser saying
   * "that one is safely in the spreadsheet", and nothing more. Which is why
   * it is safe for the browser to repeat it: a completion whose response was
   * lost can be sent again, and the second call recognises the same claim
   * finishing the same session and reports success without changing
   * anything.
   *
   * The three ways it fails all mean something different, and the browser
   * shows different things for each:
   *
   * - **Unknown claim** — `404`. The claim id is not one this server issued,
   *   or the session has since been reclaimed by somebody else and carries
   *   their id now.
   * - **Expired** — `409`. The browser was away too long. Its write may well
   *   have landed, so the honest thing is to tell the administrator rather
   *   than to stamp a session nobody can vouch for. If the session has since
   *   been extracted by somebody else the rows may now be duplicated, and
   *   `referralId` is how they are found.
   * - **Somebody else's claim** — `409`. Two administrators are working at
   *   once and this one is finishing the other's session. Stamping it here
   *   would mark a session extracted on the strength of a write this browser
   *   did not do.
   */
  async function complete(claimId: string, actor: Actor): Promise<CompleteResponse> {
    requireConfigured();

    const now = clock.nowIso();
    const updated = await sessions.markExtracted({ claimId, userId: actor.userId, at: now });

    if (updated !== undefined) {
      logger.info('session extracted', { sessionId: updated.id, userId: actor.userId });
      return {
        sessionId: updated.id,
        extractedAt: now,
        alreadyExtracted: false,
        ...(await sessions.extractProgress()),
      };
    }

    // The guarded write matched nothing. Re-read to say why — the only way to
    // tell a safe retry from an expired claim from somebody else's.
    const session = await sessions.findByExtractClaim(claimId);
    if (session === undefined) {
      throw new NotFoundError('That extract reservation is not one this server issued');
    }

    // Ownership before state, deliberately. Asking "was it already done?" first
    // would hand a success to an administrator finishing somebody else's claim
    // whenever that claim happened to have completed — telling them their write
    // is safely recorded when the server has no idea whether they made one.
    if (session.extractClaimedByUserId !== actor.userId) {
      throw new ConflictError('That extract reservation belongs to another administrator', {
        details: { sessionId: session.id },
      });
    }

    if (session.extractedAt !== null) {
      // The retry case: this same administrator's same claim already finished
      // this same session, so their intent is satisfied and repeating it
      // changed nothing.
      return {
        sessionId: session.id,
        extractedAt: session.extractedAt,
        alreadyExtracted: true,
        ...(await sessions.extractProgress()),
      };
    }

    throw new ConflictError(
      'That extract reservation has expired. The session has been returned to the queue; check the spreadsheet for rows already written before extracting it again.',
      { details: { sessionId: session.id, expiredAt: session.extractClaimExpiresAt } },
    );
  }

  async function progress(): Promise<ExtractProgress> {
    return sessions.extractProgress();
  }

  return { config, claimNext, complete, progress };
}

/**
 * Minutes onto an ISO instant, for the claim expiry.
 *
 * Not calendar arithmetic — a claim lifetime is a duration in minutes and
 * means the same across a BST changeover, so this is one of the few places
 * milliseconds are the right unit. See `.claude/rules/time.md`.
 */
function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export type ExportsService = ReturnType<typeof createExportsService>;
