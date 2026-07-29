import { Hono } from 'hono';
import type { AppEnv } from '../../http/types.ts';
import { parseJsonBody } from '../../http/validate.ts';
import { rateLimit } from '../../http/middleware/rate-limit.ts';
import { createReferrersRepository } from '../referrers/referrers.repository.ts';
import { createReferrersService } from '../referrers/referrers.service.ts';
import { referrerCheckSchema } from '../referrers/referrers.schema.ts';
import { createFormsRepository } from './forms.repository.ts';
import { createFormsService } from './forms.service.ts';
import {
  toFormFieldResponse,
  toReferralReasonResponse,
  type PublicFormResponse,
} from './forms.mapper.ts';

/**
 * Unauthenticated. A referrer fills this in before they have any credentials.
 *
 * Both routes are open write-adjacent surfaces and will need rate limiting and
 * Turnstile before go-live — tracked in CLAUDE.md.
 */
export function publicFormRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /** The published form plus the reason dropdown, in one request. */
  routes.get('/referral-form', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const db = c.get('db');
    const forms = createFormsService({
      db,
      repository: createFormsRepository(db),
      clock: c.get('clock'),
    });

    const { definition, fields } = await forms.getPublished();
    const reasons = await createReferrersRepository(db).listReasons(true);

    return c.json<PublicFormResponse>({
      formDefinitionId: definition.id,
      version: definition.version,
      title: definition.title,
      reasons: reasons.map(toReferralReasonResponse),
      fields: fields.map(toFormFieldResponse),
    });
  });

  /**
   * Whether an address may refer.
   *
   * Returns the organisation name so the form can pre-fill it. It reveals
   * which organisations are authorised, which is organisational rather than
   * personal information — but it is still an enumeration surface, hence the
   * rate limiting requirement.
   */
  routes.post('/referrers/check', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const { email } = await parseJsonBody(c, referrerCheckSchema);

    const result = await createReferrersService({
      repository: createReferrersRepository(c.get('db')),
      clock: c.get('clock'),
    }).checkAuthorisation(email);

    return c.json({
      authorised: result.authorised,
      organisationName: result.organisationName,
    });
  });

  return routes;
}
