import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);

/**
 * Migration `0007_bootstrap-admin` is the answer to "who creates the first
 * user, now that logging in does not?".
 *
 * This file never deletes users — storage isolation is per file, so it sees
 * the seeded row exactly as a freshly migrated database would.
 */
describe('the bootstrap admin', () => {
  it('exists as an active admin after the migrations run', async () => {
    const [seeded] = await db.select().from(users).where(eq(users.email, 'pete@x.com'));

    expect(seeded).toMatchObject({ role: 'admin', isActive: 1 });
  });

  it('can log in and create the rest of the team', async () => {
    const testApp = buildTestApp();

    const login = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pete@x.com' }),
    });
    expect(login.status).toBe(200);

    const { accessToken }: { accessToken: string } = await login.json();
    const created = await testApp.request('/api/v1/users', {
      method: 'POST',
      headers: { ...authHeaders(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'first-lead@foodbank.org',
        displayName: 'First Lead',
        role: 'team_lead',
      }),
    });

    expect(created.status).toBe(201);
  });
});
