import { z } from 'zod';
import { REFERRER_MATCH_TYPES } from '../../db/schema/referrers.ts';

export const referrerCheckSchema = z.object({
  email: z.email().max(254),
});

export const authorisedReferrerInputSchema = z.object({
  matchType: z.enum(REFERRER_MATCH_TYPES),
  /** `*@example.org`, `@example.org` and `example.org` are all accepted for a domain. */
  matchValue: z.string().min(3).max(254),
  organisationName: z.string().min(1).max(200),
  notes: z.string().max(1000).nullable().default(null),
});

export const authorisedReferrerPatchSchema = z
  .object({
    organisationName: z.string().min(1).max(200),
    notes: z.string().max(1000).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

export const referralReasonInputSchema = z.object({
  /** Stable machine key. Never renamed once referrals point at it. */
  code: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, 'must be lowercase letters, digits and underscores'),
  label: z.string().min(1).max(200),
  displayOrder: z.number().int().min(0).max(1000).default(0),
});

export const referralReasonPatchSchema = z
  .object({
    label: z.string().min(1).max(200),
    displayOrder: z.number().int().min(0).max(1000),
    isActive: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');
