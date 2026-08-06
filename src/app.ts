import { Hono } from 'hono';
import type { AppConfig } from './config/env.ts';
import { requestContext, securityHeaders, type ContextOptions } from './http/context.ts';
import { cors } from './http/cors.ts';
import { errorHandler, notFoundHandler } from './http/error-handler.ts';
import { authRoutes } from './modules/auth/auth.routes.ts';
import { healthRoutes } from './modules/health/health.routes.ts';
import { referrerAdminRoutes } from './modules/referrers/admin.routes.ts';
import { publicReferrerRoutes } from './modules/referrers/public.routes.ts';
import { publicReferralRoutes } from './modules/referrals/public.routes.ts';
import { referralRoutes } from './modules/referrals/referrals.routes.ts';
import { fuelHelpRoutes } from './modules/fuel-help/fuel-help.routes.ts';
import { pickListRoutes } from './modules/pick-lists/pick-lists.routes.ts';
import { ruleRoutes } from './modules/rules/rules.routes.ts';
import { publicSessionRoutes } from './modules/sessions/public.routes.ts';
import { smsRoutes } from './modules/sms/sms.routes.ts';
import { webhookRoutes } from './modules/sms/webhook.routes.ts';
import { stockRoutes } from './modules/stock/stock.routes.ts';
import { sessionRoutes } from './modules/sessions/sessions.routes.ts';
import { userRoutes } from './modules/users/users.routes.ts';
import type { AppEnv } from './http/types.ts';

export const API_PREFIX = '/api/v1';

/**
 * Builds the fully wired application without binding a fetch handler, so tests
 * can drive the whole stack through `app.request()`.
 *
 * Takes a config because **which routes exist** is a build-time decision: the
 * dev-login route is omitted entirely unless `AUTH_MODE=dummy`, rather than
 * registered and guarded. `requestContext` still loads config per request for
 * everything else — the two are not redundant, they answer different
 * questions.
 */
export function buildApp(config: AppConfig, options: ContextOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.use('*', requestContext(options));
  app.use('*', securityHeaders);
  app.use('*', cors);

  // Unprefixed so uptime probes do not need to know the API version.
  app.route('/', healthRoutes());

  app.route(`${API_PREFIX}/auth`, authRoutes(config));
  app.route(`${API_PREFIX}/public`, publicSessionRoutes());
  app.route(`${API_PREFIX}/public`, publicReferrerRoutes());
  app.route(`${API_PREFIX}/public`, publicReferralRoutes());
  app.route(API_PREFIX, sessionRoutes());
  app.route(API_PREFIX, referrerAdminRoutes());
  app.route(API_PREFIX, referralRoutes());
  app.route(API_PREFIX, fuelHelpRoutes());
  app.route(API_PREFIX, stockRoutes());
  app.route(API_PREFIX, ruleRoutes());
  app.route(API_PREFIX, pickListRoutes());
  app.route(API_PREFIX, userRoutes());
  app.route(API_PREFIX, smsRoutes());
  // Unauthenticated, like the public routes above — the provider posts here.
  // It carries its own credential check and rate limiter rather than sitting
  // behind `requireAuth`, because TheSMSWorks has no account with us.
  app.route(API_PREFIX, webhookRoutes());

  return app;
}
