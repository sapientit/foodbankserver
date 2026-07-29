import { z } from 'zod';
import { DEFAULT_SESSION_CAPACITY } from '../../config/constants.ts';
import { isPlainDate } from '../../core/time/plain-date.ts';
import { isPlainTime } from '../../core/time/london.ts';

const plainDate = z.string().refine(isPlainDate, 'must be a real YYYY-MM-DD date');
const plainTime = z.string().refine(isPlainTime, 'must be a HH:MM time');

/** London wall clock, not an instant — see core/time/london.ts. */
export const recurringSessionInputSchema = z.object({
  name: z.string().min(1).max(120),
  weekday: z.number().int().min(1).max(7),
  startTime: plainTime,
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60),
  location: z.string().min(1).max(200),
  capacity: z.number().int().min(0).max(1000).default(DEFAULT_SESSION_CAPACITY),
  activeFrom: plainDate,
  activeUntil: plainDate.nullable().default(null),
});

export const recurringSessionPatchSchema = recurringSessionInputSchema.partial();

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
