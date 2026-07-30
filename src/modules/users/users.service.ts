import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Patch } from '../../core/types.ts';
import type { NewUser, User } from '../../db/schema/users.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { UsersRepository } from './users.repository.ts';
import type { AssignableRole } from './users.schema.ts';

export interface UsersServiceDeps {
  readonly repository: UsersRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly role: AssignableRole;
}

/** What a PATCH may change. `isActive` is the database's 0/1, mapped at the edge. */
export interface UpdateUserInput {
  readonly displayName?: string | undefined;
  readonly role?: AssignableRole | undefined;
  readonly isActive?: 0 | 1 | undefined;
}

/**
 * User administration.
 *
 * Accounts exist only because an admin created one — logging in never creates
 * a user. That is the whole point of this module: the identity provider says
 * *who* somebody is, and this table says whether this food bank has given them
 * access and as what.
 */
export function createUsersService({ repository, clock, logger }: UsersServiceDeps) {
  async function create(input: CreateUserInput): Promise<User> {
    const now = clock.nowIso();

    try {
      return await repository.insert({
        id: crypto.randomUUID(),
        // Every provider resolves an account by lowercased email, so a
        // capitalised address here would simply never match a login.
        email: input.email.trim().toLowerCase(),
        displayName: input.displayName,
        role: input.role,
        googleSubject: null,
        isActive: 1,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'users.email')) {
        throw new ConflictError('A user with that email address already exists', { cause: error });
      }
      throw error;
    }
  }

  /**
   * Amends a user, refusing the two changes that lock people out of the system.
   *
   * There is no delete. Users are referenced by the stock ledger, audit events
   * and attendance, so removing a row would either fail or take the audit trail
   * with it. Deactivating is the retirement path: the account stops working at
   * the next refresh, and the history it is named in stays readable.
   */
  async function update(id: string, patch: UpdateUserInput, actor: Actor): Promise<User> {
    const existing = await repository.findById(id);
    if (existing === undefined) {
      throw new NotFoundError('User not found');
    }

    const wasActiveAdmin = existing.role === 'admin' && existing.isActive === 1;
    const isActiveAdmin =
      (patch.role ?? existing.role) === 'admin' && (patch.isActive ?? existing.isActive) === 1;
    const losesAdmin = wasActiveAdmin && !isActiveAdmin;

    if (losesAdmin && id === actor.userId) {
      throw new ConflictError('You cannot demote or deactivate your own account');
    }

    const next: Patch<NewUser> = { ...patch, updatedAt: clock.nowIso() };

    if (losesAdmin) {
      const updated = await repository.updateLeavingAnotherAdmin(id, next);
      if (updated === undefined) {
        // The row was there a moment ago and users are never deleted, so the
        // only way the conditional write matched nothing is the guard firing.
        throw new ConflictError('The last active admin cannot be demoted or deactivated');
      }

      logger.info('demoted or deactivated an admin', { userId: id, actorRole: updated.role });
      return updated;
    }

    const updated = await repository.update(id, next);
    if (updated === undefined) {
      throw new NotFoundError('User not found');
    }
    return updated;
  }

  return {
    list: (activeOnly: boolean): Promise<User[]> => repository.list(activeOnly),
    create,
    update,
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
