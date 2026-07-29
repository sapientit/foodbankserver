import { Hono, type Context } from 'hono';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createReferrersRepository } from '../referrers/referrers.repository.ts';
import { createReferrersService } from '../referrers/referrers.service.ts';
import {
  authorisedReferrerInputSchema,
  authorisedReferrerPatchSchema,
  referralReasonInputSchema,
  referralReasonPatchSchema,
} from '../referrers/referrers.schema.ts';
import { createFormsRepository } from './forms.repository.ts';
import { createFormsService } from './forms.service.ts';
import { formDraftSchema, formFieldInputSchema, formFieldPatchSchema } from './forms.schema.ts';
import {
  toAdminFormFieldResponse,
  toAdminReferralReasonResponse,
  toFormDefinitionResponse,
} from './forms.mapper.ts';

/**
 * Admin-only. Who may refer, what may be asked, and why people are referred
 * are all policy decisions — a team lead runs sessions, they do not set policy.
 *
 * Middleware is attached per route, never via a wildcard `use`. See CLAUDE.md.
 */
export function referralAdminRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const admins = [requireAuth, requireRole('admin')] as const;

  // ---- Authorised referrers ----

  routes.get('/authorised-referrers', ...admins, async (c) => {
    const rows = await referrersFor(c).list();
    return c.json({
      authorisedReferrers: rows.map((row) => ({
        id: row.id,
        matchType: row.matchType,
        matchValue: row.matchValue,
        organisationName: row.organisationName,
        isActive: row.isActive === 1,
        notes: row.notes,
      })),
    });
  });

  routes.post('/authorised-referrers', ...admins, async (c) => {
    const input = await parseJsonBody(c, authorisedReferrerInputSchema);
    const created = await referrersFor(c).create(input);

    c.get('logger').info('authorised a referrer', { code: created.matchType });
    return c.json({ id: created.id, matchValue: created.matchValue }, 201);
  });

  routes.patch('/authorised-referrers/:id', ...admins, async (c) => {
    // Booleans are destructured out rather than spread over: SQLite stores
    // them as 0/1, and spreading would leave `boolean` in the union.
    const { isActive, ...rest } = await parseJsonBody(c, authorisedReferrerPatchSchema);
    const updated = await referrersFor(c).update(c.req.param('id'), {
      ...rest,
      ...(isActive === undefined ? {} : { isActive: isActive ? 1 : 0 }),
    });

    return c.json({ id: updated.id, isActive: updated.isActive === 1 });
  });

  // ---- Referral reasons (the dropdown) ----

  routes.get('/referral-reasons', ...admins, async (c) => {
    const rows = await referrersFor(c).listReasons(false);
    return c.json({ referralReasons: rows.map(toAdminReferralReasonResponse) });
  });

  routes.post('/referral-reasons', ...admins, async (c) => {
    const input = await parseJsonBody(c, referralReasonInputSchema);
    const created = await referrersFor(c).createReason(input);

    return c.json(toAdminReferralReasonResponse(created), 201);
  });

  routes.patch('/referral-reasons/:id', ...admins, async (c) => {
    const { isActive, ...rest } = await parseJsonBody(c, referralReasonPatchSchema);
    const updated = await referrersFor(c).updateReason(c.req.param('id'), {
      ...rest,
      ...(isActive === undefined ? {} : { isActive: isActive ? 1 : 0 }),
    });

    return c.json(toAdminReferralReasonResponse(updated));
  });

  // ---- Form definitions ----

  routes.get('/form-definitions', ...admins, async (c) => {
    const rows = await formsFor(c).listDefinitions();
    return c.json({ formDefinitions: rows.map(toFormDefinitionResponse) });
  });

  routes.get('/form-definitions/:id', ...admins, async (c) => {
    const { definition, fields } = await formsFor(c).getDefinitionWithFields(c.req.param('id'));
    return c.json({
      ...toFormDefinitionResponse(definition),
      fields: fields.map(toAdminFormFieldResponse),
    });
  });

  routes.post('/form-definitions', ...admins, async (c) => {
    const { title } = await parseJsonBody(c, formDraftSchema);
    const created = await formsFor(c).createDraft(title);

    c.get('logger').info('created form draft', { formDefinitionId: created.id });
    return c.json(toFormDefinitionResponse(created), 201);
  });

  routes.post('/form-definitions/:id/publish', ...admins, async (c) => {
    const published = await formsFor(c).publish(c.req.param('id'));

    c.get('logger').info('published form version', { formDefinitionId: published.id });
    return c.json(toFormDefinitionResponse(published));
  });

  routes.post('/form-definitions/:id/fields', ...admins, async (c) => {
    const input = await parseJsonBody(c, formFieldInputSchema);
    const created = await formsFor(c).addField(c.req.param('id'), {
      key: input.key,
      label: input.label,
      helpText: input.helpText,
      type: input.type,
      isRequired: input.isRequired ? 1 : 0,
      optionsJson: input.options.length === 0 ? null : JSON.stringify(input.options),
      minValue: input.minValue,
      maxValue: input.maxValue,
      maxLength: input.maxLength,
      isPii: input.isPii ? 1 : 0,
      displayOrder: input.displayOrder,
    });

    return c.json(toAdminFormFieldResponse(created), 201);
  });

  routes.patch('/form-fields/:id', ...admins, async (c) => {
    const { isRequired, isPii, options, ...rest } = await parseJsonBody(c, formFieldPatchSchema);
    const updated = await formsFor(c).updateField(c.req.param('id'), {
      ...rest,
      ...(isRequired === undefined ? {} : { isRequired: isRequired ? 1 : 0 }),
      ...(isPii === undefined ? {} : { isPii: isPii ? 1 : 0 }),
      ...(options === undefined
        ? {}
        : { optionsJson: options.length === 0 ? null : JSON.stringify(options) }),
    });

    return c.json(toAdminFormFieldResponse(updated));
  });

  routes.delete('/form-fields/:id', ...admins, async (c) => {
    await formsFor(c).deleteField(c.req.param('id'));
    return c.body(null, 204);
  });

  return routes;
}

function referrersFor(c: Context<AppEnv>) {
  return createReferrersService({
    repository: createReferrersRepository(c.get('db')),
    clock: c.get('clock'),
  });
}

function formsFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createFormsService({ db, repository: createFormsRepository(db), clock: c.get('clock') });
}
