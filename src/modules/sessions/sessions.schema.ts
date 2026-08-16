import { z } from 'zod';
import { DEFAULT_SESSION_CAPACITY } from '../../config/constants.ts';
import { isPlainDate } from '../../core/time/plain-date.ts';
import { isPlainTime } from '../../core/time/london.ts';

const plainDate = z.string().refine(isPlainDate, 'must be a real YYYY-MM-DD date');
const plainTime = z.string().refine(isPlainTime, 'must be a HH:MM time');

const capacity = z.number().int().min(0).max(1000);
const activeUntil = plainDate.nullable();
/**
 * `HH:MM` London wall clock, both or neither — see the comment on
 * `recurringSessions.deliveryWindowStart` in the schema. It is read out,
 * never scheduled or filtered on, so unlike `startTime` there is no derived
 * instant beside it. The pairing and ordering rules live in the refinements
 * below, applied to every schema that carries these two fields.
 */
const deliveryWindowStart = plainTime.nullable();
const deliveryWindowEnd = plainTime.nullable();

/**
 * Comparing two zero-padded `HH:MM` strings lexicographically is the same as
 * comparing them chronologically — `"09:00" < "13:00" < "13:05"` — so string
 * comparison is used rather than parsing into minutes.
 */
function endIsAfterStart(start: string, end: string): boolean {
  return end > start;
}

/**
 * Rule 1 and rule 2 for a **create** schema, where both fields are always
 * present (defaulted to `null`): both null, or both set with the end
 * strictly after the start.
 */
function refineCreateDeliveryWindow<
  T extends { deliveryWindowStart: string | null; deliveryWindowEnd: string | null },
>(schema: z.ZodType<T>) {
  return schema.refine(
    (value) =>
      (value.deliveryWindowStart === null && value.deliveryWindowEnd === null) ||
      (value.deliveryWindowStart !== null &&
        value.deliveryWindowEnd !== null &&
        endIsAfterStart(value.deliveryWindowStart, value.deliveryWindowEnd)),
    {
      message:
        'deliveryWindowStart and deliveryWindowEnd must both be null, or both set with the end strictly after the start',
      path: ['deliveryWindowEnd'],
    },
  );
}

/**
 * Rule 1 and rule 2 for a **patch** schema, where either field may be absent
 * (the caller did not mention the window at all). Presence is checked with
 * `in` rather than an `undefined` check, because `exactOptionalPropertyTypes`
 * makes an explicit `{ deliveryWindowStart: undefined }` a real, distinct
 * value from an absent key, and only the key's presence should count as "the
 * caller mentioned this".
 */
function refinePatchDeliveryWindow<
  T extends {
    deliveryWindowStart?: string | null | undefined;
    deliveryWindowEnd?: string | null | undefined;
  },
>(schema: z.ZodType<T>) {
  return schema
    .refine((value) => 'deliveryWindowStart' in value === 'deliveryWindowEnd' in value, {
      message: 'deliveryWindowStart and deliveryWindowEnd must be set or cleared together',
      path: ['deliveryWindowEnd'],
    })
    .refine(
      (value) => {
        const { deliveryWindowStart, deliveryWindowEnd } = value;
        // The presence refinement above already requires both-or-neither key;
        // the `undefined` checks here are only to narrow the type back from
        // "optional, possibly absent" to "definitely a string or null".
        if (deliveryWindowStart === undefined || deliveryWindowEnd === undefined) return true;
        return (
          (deliveryWindowStart === null && deliveryWindowEnd === null) ||
          (deliveryWindowStart !== null &&
            deliveryWindowEnd !== null &&
            endIsAfterStart(deliveryWindowStart, deliveryWindowEnd))
        );
      },
      {
        message:
          'deliveryWindowStart and deliveryWindowEnd must both be null, or both set with the end strictly after the start',
        path: ['deliveryWindowEnd'],
      },
    );
}

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
  deliveryWindowStart,
  deliveryWindowEnd,
  deliveriesAllowed: z.boolean(),
  activeFrom: plainDate,
  activeUntil,
});

export const recurringSessionInputSchema = refineCreateDeliveryWindow(
  recurringSessionFields.extend({
    capacity: capacity.default(DEFAULT_SESSION_CAPACITY),
    deliveryWindowStart: deliveryWindowStart.default(null),
    deliveryWindowEnd: deliveryWindowEnd.default(null),
    deliveriesAllowed: z.boolean().default(true),
    activeUntil: activeUntil.default(null),
  }),
);

// The empty patch is refused rather than treated as a no-op: the service stamps
// `updatedAt` on every amendment, so an empty body would otherwise touch the row
// and report success without changing anything the caller asked about.
export const recurringSessionPatchSchema = refinePatchDeliveryWindow(
  recurringSessionFields.partial(),
).refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

/** An ad hoc session, belonging to no template. */
export const adHocSessionSchema = refineCreateDeliveryWindow(
  z.object({
    sessionDate: plainDate,
    startTime: plainTime,
    durationMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60),
    location: z.string().min(1).max(200),
    capacity: z.number().int().min(0).max(1000).default(DEFAULT_SESSION_CAPACITY),
    deliveryWindowStart: deliveryWindowStart.default(null),
    deliveryWindowEnd: deliveryWindowEnd.default(null),
    deliveriesAllowed: z.boolean().default(true),
  }),
);

export const sessionPatchSchema = refinePatchDeliveryWindow(
  z
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
      deliveryWindowStart,
      deliveryWindowEnd,
      deliveriesAllowed: z.boolean(),
    })
    .partial(),
).refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

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
