import { FUEL_HELP_WINDOW_DAYS } from '../../config/constants.ts';
import type { Clock } from '../../core/clock.ts';
import { instantToLondonWallClock } from '../../core/time/london.ts';
import { addDays } from '../../core/time/plain-date.ts';
import { toFuelHelpHousehold, type FuelHelpHousehold } from './fuel-help.mapper.ts';
import type { FuelHelpRepository } from './fuel-help.repository.ts';

export interface FuelHelpServiceDeps {
  readonly repository: FuelHelpRepository;
  readonly clock: Clock;
}

/**
 * The fuel help list.
 *
 * Three of the four conditions are in the repository's WHERE clause, because
 * they are facts about a row. What is here is the fourth, which is the only
 * part that depends on when you ask.
 *
 * There is no `Actor`. The role decides *whether* somebody may read this list,
 * not *what* they get, so there is nothing for the service to narrow — unlike
 * a referral, which an administrator and a team leader see differently.
 */
export function createFuelHelpService({ repository, clock }: FuelHelpServiceDeps) {
  async function list(): Promise<FuelHelpHousehold[]> {
    // London's date, not UTC's: at 00:30 on a summer morning they differ, and
    // taking the wrong one moves the whole window by a day. `sessionDate` is a
    // London wall-clock date, so the bound has to be one too — never
    // milliseconds subtracted from an instant, which is date maths outside
    // `core/time` and would be wrong across the BST boundary anyway.
    const today = instantToLondonWallClock(clock.nowIso()).date;

    // Fourteen dates *including today*, so the earliest is thirteen days back.
    const earliest = addDays(today, -(FUEL_HELP_WINDOW_DAYS - 1));

    const rows = await repository.listFuelHelpSince(earliest);

    // Which fixed fields each row carries is decided by the form that
    // referral was filled in under, so read the flags of every form on the
    // list once — a fortnight's referrals share a handful of releases.
    const formIds = new Set<string>();
    for (const { referral } of rows) if (referral.formId !== null) formIds.add(referral.formId);
    const flagged = new Map<string, Set<string>>();
    for (const { formId, keyField } of await repository.listFuelTeamKeyFields([...formIds])) {
      const fields = flagged.get(formId) ?? new Set<string>();
      fields.add(keyField);
      flagged.set(formId, fields);
    }

    const noFields: ReadonlySet<string> = new Set();
    return rows.map(({ referral, session }) =>
      toFuelHelpHousehold(referral, session, flagged.get(referral.formId ?? '') ?? noFields),
    );
  }

  return { list };
}

export type FuelHelpService = ReturnType<typeof createFuelHelpService>;
