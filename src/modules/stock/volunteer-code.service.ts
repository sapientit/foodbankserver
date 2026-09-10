import {
  VOLUNTEER_CODE_RENEWAL_WARNING_SECONDS,
  VOLUNTEER_CODE_TTL_SECONDS,
} from '../../config/constants.ts';
import type { Clock } from '../../core/clock.ts';
import { mintVolunteerCode, normaliseVolunteerCode, sha256Hex } from '../../core/crypto/tokens.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import type { Database } from '../../db/client.ts';
import {
  createVolunteerCodeRepository,
  type VolunteerCodeRepository,
} from './volunteer-code.repository.ts';

export interface VolunteerCodeServiceDeps {
  readonly db: Database;
  readonly repository: VolunteerCodeRepository;
  readonly clock: Clock;
}

export interface GeneratedVolunteerCode {
  /** The plaintext code. Returned to the client once, never stored or logged. */
  readonly code: string;
  readonly expiresAt: number;
}

/** What a request authenticated by a volunteer code resolves to. */
export interface VolunteerCodeActor {
  readonly volunteerCodeId: string;
  /** The team lead who issued the code — who a count on it is recorded against. */
  readonly createdByUserId: string;
}

/**
 * The most recently generated code that has not lapsed, for the admin "a
 * fresh code is due" warning. Carries when it expires and nothing else — not
 * the code (only a hash is stored), and not who made it.
 */
export interface LatestVolunteerCode {
  readonly expiresAt: number;
  /** True once the code has less than `VOLUNTEER_CODE_RENEWAL_WARNING_SECONDS` left. */
  readonly expiringSoon: boolean;
}

export function createVolunteerCodeService(deps: VolunteerCodeServiceDeps) {
  const { db, repository, clock } = deps;

  /**
   * Issues a fresh code for `createdByUserId` and, in the same batch, sweeps
   * any that have lapsed — the only thing that ever removes a code.
   */
  async function generate(createdByUserId: string): Promise<GeneratedVolunteerCode> {
    const code = mintVolunteerCode();
    const createdAt = clock.nowEpochSeconds();
    const expiresAt = createdAt + VOLUNTEER_CODE_TTL_SECONDS;

    await db.batch([
      repository.buildDeleteExpired(createdAt),
      repository.buildInsert({
        id: crypto.randomUUID(),
        codeHash: await sha256Hex(normaliseVolunteerCode(code)),
        createdByUserId,
        createdAt,
        expiresAt,
      }),
    ]);

    return { code, expiresAt };
  }

  /**
   * Resolves a presented code to the team lead who issued it, or refuses.
   * Every failure returns the same message: a caller probing codes should not
   * learn whether one was unknown or merely expired.
   */
  async function authenticate(presented: string): Promise<VolunteerCodeActor> {
    const row = await repository.findByHash(await sha256Hex(normaliseVolunteerCode(presented)));
    if (row === undefined || row.expiresAt <= clock.nowEpochSeconds()) {
      throw new UnauthorizedError('Invalid volunteer code');
    }
    return { volunteerCodeId: row.id, createdByUserId: row.createdByUserId };
  }

  /**
   * The unexpired code with the latest issue time, for the admin screen's
   * warning that a replacement is due. `null` when there is no unexpired code
   * — before the first is generated, or once the last has lapsed.
   */
  async function latest(): Promise<LatestVolunteerCode | null> {
    const now = clock.nowEpochSeconds();
    const row = await repository.findLatestActive(now);
    if (row === undefined) {
      return null;
    }
    return {
      expiresAt: row.expiresAt,
      expiringSoon: row.expiresAt - now < VOLUNTEER_CODE_RENEWAL_WARNING_SECONDS,
    };
  }

  return { generate, authenticate, latest };
}

export type VolunteerCodeService = ReturnType<typeof createVolunteerCodeService>;

export function volunteerCodeServiceFrom(db: Database, clock: Clock): VolunteerCodeService {
  return createVolunteerCodeService({
    db,
    repository: createVolunteerCodeRepository(db),
    clock,
  });
}
