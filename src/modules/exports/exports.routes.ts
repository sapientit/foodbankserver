import { Hono, type Context } from 'hono';
import type { Actor } from '../../core/actor.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import type { AppEnv } from '../../http/types.ts';
import { createReferralsRepository } from '../referrals/referrals.repository.ts';
import { createReferralsService } from '../referrals/referrals.service.ts';
import { createReferrersRepository } from '../referrers/referrers.repository.ts';
import { createReferrersService } from '../referrers/referrers.service.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import {
  createExportsService,
  extractConfig,
  type ClaimResponse,
  type CompleteResponse,
  type ExtractConfigResponse,
} from './exports.service.ts';

/**
 * Extracting confirmed sessions to the charity's Google spreadsheet.
 *
 * **Administrator only, every route.** This is where a household's own
 * details are handed out to be written somewhere neither `requireRole` nor
 * the purge can follow, so it is not a thing a team leader does on the day.
 *
 * **The server never calls Google.** The browser holds the administrator's
 * own Google consent and does the writing; these routes hand out
 * configuration, hand out one session at a time, and record that a session
 * has been written. See `INITIAL_SPEC1.txt`, `#Sending referrals to the
 * spreadsheet`.
 *
 * **No `routes.use('*', ...)`.** This sub-app shares the `/api/v1` prefix, so
 * a wildcard `use` here would apply to every path under that prefix rather
 * than to this module's routes. See `test/route-mounting.test.ts`.
 */
export function exportRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const admins = [requireAuth, requireRole('admin')] as const;

  /**
   * Which spreadsheet, and which OAuth client to ask consent against.
   *
   * The browser needs both before it can start, and it asks for Google
   * consent only after the administrator has agreed to begin — so this is
   * read at the start of an extract rather than on page load.
   */
  routes.get('/extracts/config', ...admins, (c) => {
    return c.json<ExtractConfigResponse>(serviceFor(c).config());
  });

  /**
   * How much is left. For the screen, and for the "carry on?" question the
   * browser asks after twenty sessions.
   */
  routes.get('/extracts', ...admins, async (c) => {
    return c.json(await serviceFor(c).progress());
  });

  /**
   * Reserves the next session and returns it with every referral on it.
   *
   * `claim: null` means the queue is empty — the ordinary way a batch ends,
   * not an error.
   */
  routes.post('/extracts/claims', ...admins, async (c) => {
    return c.json<ClaimResponse>(await serviceFor(c).claimNext(actorOf(c)));
  });

  /**
   * Records that the browser wrote this claim's session to the spreadsheet.
   *
   * **Never triggers a Google write**, and is safe for the browser to repeat
   * if it never saw the response.
   */
  routes.post('/extracts/claims/:claimId/complete', ...admins, async (c) => {
    const result = await serviceFor(c).complete(c.req.param('claimId'), actorOf(c));
    return c.json<CompleteResponse>(result);
  });

  return routes;
}

function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (actor === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return actor;
}

function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  const clock = c.get('clock');
  const referrers = createReferrersRepository(db);
  const referrersService = createReferrersService({ repository: referrers, clock });

  return createExportsService({
    sessions: createSessionsRepository(db),
    referralsService: createReferralsService({
      db,
      clock,
      logger: c.get('logger'),
      repository: createReferralsRepository(db),
      sessions: createSessionsRepository(db),
      referrers,
      referrersService,
    }),
    referrersService,
    clock,
    logger: c.get('logger'),
    google: extractConfig(c.get('config')),
  });
}
