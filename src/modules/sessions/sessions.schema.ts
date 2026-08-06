import { z } from 'zod';
import { DEFAULT_SESSION_CAPACITY } from '../../config/constants.ts';
import { isPlainDate } from '../../core/time/plain-date.ts';
import { isPlainTime } from '../../core/time/london.ts';

const plainDate = z.string().refine(isPlainDate, 'must be a real YYYY-MM-DD date');
const plainTime = z.string().refine(isPlainTime, 'must be a HH:MM time');

const capacity = z.number().int().min(0).max(1000);
const activeUntil = plainDate.nullable();
/**
 * `HH:MM` London wall clock, or null for "the same as `startTime`" — see the
 * comment on `recurringSessions.deliveryTime` in the schema. It is read out,
 * never scheduled or filtered on, so unlike `startTime` there is no derived
 * instant beside it.
 */
const deliveryTime = plainTime.nullable();

/**
 * London wall clock, not an instant — see core/time/london.ts.
 *
 * The defaults live on the create schema alone. A patch schema derived with
 * `.partial()` keeps them, and an optional-with-a-default field still produces
 * its default from an absent key — so amending only the name would rewrite the
 * capacity and clear the end date.
 */
const recurringSessionFields = z.object({
  name: z.string().min(1).max(120),
  weekday: z.number().int().min(1).max(7),
  startTime: plainTime,
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60),
  location: z.string().min(1).max(200),
  capacity,
  deliveryTime,
  deliveriesAllowed: z.boolean(),
  activeFrom: plainDate,
  activeUntil,
});

export const recurringSessionInputSchema = recurringSessionFields.extend({
  capacity: capacity.default(DEFAULT_SESSION_CAPACITY),
  deliveryTime: deliveryTime.default(null),
  deliveriesAllowed: z.boolean().default(true),
  activeUntil: activeUntil.default(null),
});

// The empty patch is refused rather than treated as a no-op: the service stamps
// `updatedAt` on every amendment, so an empty body would otherwise touch the row
// and report success without changing anything the caller asked about.
export const recurringSessionPatchSchema = recurringSessionFields
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

/** An ad hoc session, belonging to no template. */
export const adHocSessionSchema = z.object({
  sessionDate: plainDate,
  startTime: plainTime,
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60),
  location: z.string().min(1).max(200),
  capacity: z.number().int().min(0).max(1000).default(DEFAULT_SESSION_CAPACITY),
  deliveryTime: deliveryTime.default(null),
  deliveriesAllowed: z.boolean().default(true),
});

export const sessionPatchSchema = z
  .object({
    sessionDate: plainDate,
    startTime: plainTime,
    durationMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60),
    location: z.string().min(1).max(200),
    capacity: z.number().int().min(0).max(1000),
    deliveryTime,
    deliveriesAllowed: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

export const cancelSessionSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

export const sessionListQuerySchema = z.object({
  from: plainDate.optional(),
  to: plainDate.optional(),
  status: z.enum(['planned', 'in_progress', 'confirmed', 'cancelled']).optional(),
});

export type RecurringSessionInput = z.infer<typeof recurringSessionInputSchema>;
export type AdHocSessionInput = z.infer<typeof adHocSessionSchema>;
export type SessionPatch = z.infer<typeof sessionPatchSchema>;
