import { SESSION_HORIZON_WEEKS } from '../../config/constants.ts';
import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import { instantToLondonWallClock } from '../../core/time/london.ts';
import type { Database } from '../../db/client.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import {
  horizonEnd,
  missingOccurrences,
  occurrenceKey,
  planOccurrences,
  type RecurrenceTemplate,
} from '../sessions/materialisation.ts';

export const MATERIALISE_SESSIONS_JOB = 'session-materialisation';

export interface MaterialiseResult {
  readonly from: string;
  readonly to: string;
  readonly templatesConsidered: number;
  readonly occurrencesPlanned: number;
  readonly sessionsCreated: number;
}

export interface MaterialiseDeps {
  readonly db: Database;
  readonly repository: SessionsRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly horizonWeeks?: number;
}

/**
 * Generates the next six weeks of sessions from recurring templates.
 *
 * Idempotent three ways over, which matters because this runs unattended and
 * can also be triggered by hand:
 *
 * 1. The diff means a second run finds nothing to insert.
 * 2. `UNIQUE (recurring_session_id, occurrence_date)` means even genuinely
 *    concurrent runs cannot duplicate a slot.
 * 3. `ON CONFLICT DO NOTHING` means a lost race skips one row rather than
 *    aborting the batch and discarding the others.
 *
 * **It never UPDATEs an existing row.** That is what makes an admin's
 * re-timed, re-located or cancelled occurrence safe by construction — there is
 * no reconciliation step that could undo their edit.
 *
 * Query budget: 2 reads + 1 batched write + 1 job upsert. Well inside the
 * 50-per-invocation free-tier ceiling however many templates exist, because
 * nothing here is per-template.
 */
export async function materialiseSessions(deps: MaterialiseDeps): Promise<MaterialiseResult> {
  const { db, repository, clock, logger } = deps;
  const horizonWeeks = deps.horizonWeeks ?? SESSION_HORIZON_WEEKS;

  // "Today" in London, not UTC — at 00:30 BST those are different dates.
  const from = instantToLondonWallClock(clock.nowIso()).date;
  const window = { from, horizonWeeks };
  const to = horizonEnd(window);

  const templates = await repository.listRecurringActiveInWindow(from, to);
  const planned = planOccurrences(templates.map(toRecurrenceTemplate), window);

  const existing = await repository.findExistingOccurrences(from, to);
  const existingKeys = new Set(
    existing.flatMap(({ recurringSessionId, occurrenceDate }) =>
      recurringSessionId === null || occurrenceDate === null
        ? []
        : [occurrenceKey(recurringSessionId, occurrenceDate)],
    ),
  );

  const missing = missingOccurrences(planned, existingKeys);
  const now = clock.nowIso();

  if (missing.length > 0) {
    const statements = missing.map((occurrence) =>
      repository.buildInsertSession({
        id: crypto.randomUUID(),
        recurringSessionId: occurrence.recurringSessionId,
        occurrenceDate: occurrence.occurrenceDate,
        sessionDate: occurrence.sessionDate,
        startTime: occurrence.startTime,
        startsAtUtc: occurrence.startsAtUtc,
        durationMinutes: occurrence.durationMinutes,
        location: occurrence.location,
        capacity: occurrence.capacity,
        status: 'planned',
        cancelledReason: null,
        isCustomised: 0,
        generatedAt: now,
        confirmedAt: null,
        confirmedByUserId: null,
        createdAt: now,
        updatedAt: now,
      }),
    );

    // Non-empty by the guard above, which `db.batch` requires.
    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  }

  logger.info('materialised sessions', {
    jobName: MATERIALISE_SESSIONS_JOB,
    count: missing.length,
  });

  return {
    from,
    to,
    templatesConsidered: templates.length,
    occurrencesPlanned: planned.length,
    sessionsCreated: missing.length,
  };
}

function toRecurrenceTemplate(row: {
  id: string;
  weekday: number;
  startTime: string;
  durationMinutes: number;
  location: string;
  capacity: number;
  activeFrom: string;
  activeUntil: string | null;
}): RecurrenceTemplate {
  return {
    id: row.id,
    weekday: row.weekday,
    startTime: row.startTime,
    durationMinutes: row.durationMinutes,
    location: row.location,
    capacity: row.capacity,
    activeFrom: row.activeFrom,
    activeUntil: row.activeUntil,
  };
}
