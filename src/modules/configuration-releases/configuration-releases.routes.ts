import { Hono, type Context } from 'hono';
import type { Actor } from '../../core/actor.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody, parseOrThrow } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createConfigurationReleasesRepository } from './configuration-releases.repository.ts';
import { createConfigurationReleasesService } from './configuration-releases.service.ts';
import {
  toConfigurationReleaseQuestionnaireResponse,
  toConfigurationReleaseResponse,
  toConfigurationReleaseSummaryResponse,
  type ConfigurationReleaseQuestionnaireResponse,
  type ConfigurationReleaseResponse,
  type ConfigurationReleaseSummaryResponse,
} from './configuration-releases.mapper.ts';
import { toWorkbookConfigResponse, type WorkbookConfigResponse } from './workbook-config.ts';
import {
  bulkFormIdsQuerySchema,
  configurationReleaseUploadSchema,
} from './configuration-releases.schema.ts';

/**
 * The referral form and its preference rules as versioned releases. See
 * `INITIAL_SPEC1.txt`, `#referral`, and the doc comments on
 * `db/schema/configuration-releases.ts` and `configuration-releases.service.ts`.
 *
 * **The server stores and serves releases verbatim; it never reads one.**
 * `questionnaire` and `rules` travel as opaque strings both in and out — no
 * route here parses either.
 *
 * **Rules never reach the public** — the spec gives the public form the
 * questions of the release in use and never its rules. That route is in
 * `public.routes.ts`.
 *
 * Uploading, publishing and rolling back are admin only — this is
 * configuration of the referral form itself. Reading a release whole is admin
 * only too, except the bulk-by-id read below, which a team leader and a fuel
 * administrator also need: the picking list and the fuel help list both show
 * a household's answers, and showing an answer without its question is
 * useless.
 */
export function configurationReleaseRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const admins = [requireAuth, requireRole('admin')] as const;
  const readers = [requireAuth, requireRole('admin', 'team_lead', 'fuel_admin')] as const;

  routes.post('/configuration-releases', ...admins, async (c) => {
    const input = await parseJsonBody(c, configurationReleaseUploadSchema);
    const created = await serviceFor(c).upload(input, actorOf(c));

    return c.json<ConfigurationReleaseResponse>(toConfigurationReleaseResponse(created), 201);
  });

  routes.post('/configuration-releases/:formId/publish', ...admins, async (c) => {
    const published = await serviceFor(c).publish(c.req.param('formId'), actorOf(c));
    return c.json<ConfigurationReleaseResponse>(toConfigurationReleaseResponse(published));
  });

  routes.post('/configuration-releases/:formId/rollback', ...admins, async (c) => {
    const rolledBack = await serviceFor(c).rollback(c.req.param('formId'), actorOf(c));
    return c.json<ConfigurationReleaseResponse>(toConfigurationReleaseResponse(rolledBack));
  });

  /**
   * The configuration workbook and the OAuth client, for the publish screen.
   * Admin only, like publishing itself. Literal path, so registered ahead of
   * anything shaped `/:formId`.
   */
  routes.get('/configuration-releases/config', ...admins, (c) => {
    return c.json<WorkbookConfigResponse>(toWorkbookConfigResponse(c.get('config')));
  });

  // Registered ahead of any future `/:formId`-shaped GET — there is none today,
  // but a literal segment like `bulk` must never be swallowed by a param route.
  routes.get('/configuration-releases/bulk', ...readers, async (c) => {
    const { formIds } = parseOrThrow(bulkFormIdsQuerySchema, {
      formIds: c.req.query('formIds'),
    });
    const uniqueFormIds = [...new Set(formIds)];

    const releases = await serviceFor(c).findMany(uniqueFormIds);
    // A fuel administrator labels answers and never picks, so is given the
    // questions without the rules.
    const toResponse =
      actorOf(c).role === 'fuel_admin'
        ? toConfigurationReleaseQuestionnaireResponse
        : toConfigurationReleaseResponse;
    return c.json<{
      releases: (ConfigurationReleaseResponse | ConfigurationReleaseQuestionnaireResponse)[];
    }>({
      releases: releases.map(toResponse),
    });
  });

  routes.get('/configuration-releases', ...admins, async (c) => {
    const summaries = await serviceFor(c).history();
    return c.json<ConfigurationReleaseSummaryResponse[]>(
      summaries.map(toConfigurationReleaseSummaryResponse),
    );
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

export function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createConfigurationReleasesService({
    db,
    repository: createConfigurationReleasesRepository(db),
    clock: c.get('clock'),
  });
}
