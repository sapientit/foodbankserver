import { Hono, type Context } from 'hono';
import type { Actor } from '../../core/actor.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import type { AppEnv } from '../../http/types.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { User } from '../../db/schema/users.ts';
import { createUsersRepository } from './users.repository.ts';
import { createUsersService } from './users.service.ts';
import { userInputSchema, userPatchSchema } from './users.schema.ts';

interface UserResponse {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

/**
 * User maintenance. Admin only, throughout — deciding who may see referrals is
 * not something a team lead does.
 */
export function userRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const admins = [requireAuth, requireRole('admin')] as const;

  routes.get('/users', ...admins, async (c) => {
    const found = await serviceFor(c).list(c.req.query('includeInactive') !== 'true');
    return c.json<{ users: UserResponse[] }>({ users: found.map(toUserResponse) });
  });

  routes.post('/users', ...admins, async (c) => {
    const created = await serviceFor(c).create(await parseJsonBody(c, userInputSchema));

    c.get('logger').info('created user', { userId: created.id, actorRole: created.role });
    return c.json(toUserResponse(created), 201);
  });

  routes.patch('/users/:id', ...admins, async (c) => {
    const { isActive, ...rest } = await parseJsonBody(c, userPatchSchema);
    const updated = await serviceFor(c).update(
      c.req.param('id'),
      { ...rest, ...(isActive === undefined ? {} : { isActive: isActive ? 1 : 0 }) },
      actorOf(c),
    );

    return c.json(toUserResponse(updated));
  });

  return routes;
}

/**
 * The output allowlist. `googleSubject` is an identifier for the identity
 * provider's benefit, not the client's, so it stops here.
 */
function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive === 1,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (actor === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return actor;
}

function serviceFor(c: Context<AppEnv>) {
  return createUsersService({
    repository: createUsersRepository(c.get('db')),
    clock: c.get('clock'),
    logger: c.get('logger'),
  });
}
