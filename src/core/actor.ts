import type { UserRole } from '../db/schema/users.ts';

/**
 * Who is making a request.
 *
 * Services take an `Actor`, never a Hono `Context`. That is what keeps the
 * domain layer testable without constructing a request, and what stops
 * authorisation logic drifting into route handlers.
 *
 * Note there is no `name` here, and there never should be: actors get logged.
 */
export interface Actor {
  readonly userId: string;
  readonly email: string;
  readonly role: UserRole;
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'admin';
}

/** True when the actor holds any of the given roles. */
export function hasRole(actor: Actor, ...roles: readonly UserRole[]): boolean {
  return roles.includes(actor.role);
}
