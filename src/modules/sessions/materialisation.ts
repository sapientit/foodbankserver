import { londonWallClockToInstant } from '../../core/time/london.ts';
import {
  addDays,
  comparePlainDates,
  weeklyOccurrences,
  type PlainDate,
} from '../../core/time/plain-date.ts';

/**
 * Deciding which sessions *should* exist over a horizon.
 *
 * Deliberately pure — no database, no clock, no bindings. Every awkward part
 * of session generation lives here (weekly recurrence, template activity
 * windows, and converting a wall-clock time to an instant across the BST
 * boundary), which means all of it is unit-testable without a Worker.
 *
 * The job in `modules/jobs` supplies the templates and persists the diff.
 */

export interface RecurrenceTemplate {
  readonly id: string;
  /** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
  readonly weekday: number;
  /** `HH:MM`, Europe/London wall clock. */
  readonly startTime: string;
  readonly durationMinutes: number;
  readonly location: string;
  readonly capacity: number;
  readonly activeFrom: PlainDate;
  readonly activeUntil: PlainDate | null;
}

export interface PlannedOccurrence {
  readonly recurringSessionId: string;
  readonly occurrenceDate: PlainDate;
  readonly sessionDate: PlainDate;
  readonly startTime: string;
  readonly startsAtUtc: string;
  readonly durationMinutes: number;
  readonly location: string;
  readonly capacity: number;
}

export interface PlanWindow {
  /** First date to consider, `YYYY-MM-DD` London. Usually today. */
  readonly from: PlainDate;
  readonly horizonWeeks: number;
}

/** The last date in the horizon, inclusive. */
export function horizonEnd(window: PlanWindow): PlainDate {
  return addDays(window.from, window.horizonWeeks * 7);
}

/**
 * Every occurrence each active template should produce within the window.
 *
 * A template contributes only on days inside its own `activeFrom`/`activeUntil`
 * range, so retiring a weekly session is a matter of setting `activeUntil`
 * rather than deleting anything already generated.
 */
export function planOccurrences(
  templates: readonly RecurrenceTemplate[],
  window: PlanWindow,
): PlannedOccurrence[] {
  const windowEnd = horizonEnd(window);
  const planned: PlannedOccurrence[] = [];

  for (const template of templates) {
    // Clamp the template's own activity range against the horizon.
    const start =
      comparePlainDates(template.activeFrom, window.from) > 0 ? template.activeFrom : window.from;
    const end =
      template.activeUntil !== null && comparePlainDates(template.activeUntil, windowEnd) < 0
        ? template.activeUntil
        : windowEnd;

    if (comparePlainDates(start, end) > 0) continue;

    for (const date of weeklyOccurrences(start, end, template.weekday)) {
      planned.push({
        recurringSessionId: template.id,
        occurrenceDate: date,
        sessionDate: date,
        startTime: template.startTime,
        // The conversion that makes 10:00 stay 10:00 across BST.
        startsAtUtc: londonWallClockToInstant(date, template.startTime),
        durationMinutes: template.durationMinutes,
        location: template.location,
        capacity: template.capacity,
      });
    }
  }

  return planned.sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc));
}

/** Stable key identifying a template slot. */
export function occurrenceKey(recurringSessionId: string, occurrenceDate: PlainDate): string {
  return `${recurringSessionId}::${occurrenceDate}`;
}

/**
 * The occurrences that do not exist yet.
 *
 * Comparing on the template slot rather than the session date is what makes a
 * re-timed session safe: an admin moving Tuesday's session to Wednesday does
 * not make the cron think Tuesday is missing.
 */
export function missingOccurrences(
  planned: readonly PlannedOccurrence[],
  existingKeys: ReadonlySet<string>,
): PlannedOccurrence[] {
  return planned.filter(
    (occurrence) =>
      !existingKeys.has(occurrenceKey(occurrence.recurringSessionId, occurrence.occurrenceDate)),
  );
}
