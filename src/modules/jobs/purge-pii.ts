import { and, isNull, lt } from 'drizzle-orm';
import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import { eq } from 'drizzle-orm';
import { formFields } from '../../db/schema/forms.ts';
import { referrals } from '../../db/schema/referrals.ts';

export const PURGE_PII_JOB = 'purge-referral-pii';

export interface PurgePiiResult {
  readonly purged: number;
  readonly retentionDays: number | undefined;
}

/**
 * Removes personal data from referrals older than the retention period.
 *
 * ## Why this is safe to run
 *
 * `adults`, `children`, `isDelivery` and `reasonId` are deliberately outside
 * the PII block and are **kept**. Once the identifying columns are null the
 * referee is no longer identifiable, so those become statistics — which is how
 * "we fed 340 households, 890 people, 22% for benefit delay" survives a purge.
 * That only works because the reason is a dropdown; free text would have to go.
 *
 * Dynamic answers are filtered rather than dropped: each form field carries
 * `isPii`, so a non-personal answer (dietary needs, say) is retained while the
 * rest is discarded.
 *
 * ## Why it does nothing by default
 *
 * `retentionDays` is undefined unless the charity has set a period. Guessing
 * one and deleting somebody's data on that guess would be worse than doing
 * nothing, so with no configuration this reports zero and stops.
 */
export async function purgeReferralPii(deps: {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly retentionDays: number | undefined;
}): Promise<PurgePiiResult> {
  const { db, clock, logger, retentionDays } = deps;

  if (retentionDays === undefined) {
    return { purged: 0, retentionDays };
  }

  const cutoff = new Date(
    Date.parse(clock.nowIso()) - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const candidates = await db
    .select()
    .from(referrals)
    .where(and(lt(referrals.referredAt, cutoff), isNull(referrals.piiPurgedAt)));

  if (candidates.length === 0) {
    return { purged: 0, retentionDays };
  }

  // One query for every field definition involved, rather than one per
  // referral — a purge may touch thousands of rows.
  const fields = await db.select().from(formFields);
  const piiKeysByForm = new Map<string, Set<string>>();
  for (const field of fields) {
    const existing = piiKeysByForm.get(field.formDefinitionId) ?? new Set<string>();
    if (field.isPii === 1) existing.add(field.key);
    piiKeysByForm.set(field.formDefinitionId, existing);
  }

  const now = clock.nowIso();
  let purged = 0;

  for (const referral of candidates) {
    const piiKeys = piiKeysByForm.get(referral.formDefinitionId) ?? new Set<string>();

    await db
      .update(referrals)
      .set({
        referrerEmail: null,
        referrerPhone: null,
        refereeName: null,
        refereeAddress: null,
        refereePostcode: null,
        refereePhone: null,
        deliveryAddress: null,
        answersJson: stripPii(referral.answersJson, piiKeys),
        piiPurgedAt: now,
        updatedAt: now,
      })
      .where(eq(referrals.id, referral.id));

    purged += 1;
  }

  logger.info('purged referral personal data', { jobName: PURGE_PII_JOB, count: purged });
  return { purged, retentionDays };
}

/** Keeps answers to questions not marked as personal data. */
function stripPii(answersJson: string | null, piiKeys: ReadonlySet<string>): string | null {
  if (answersJson === null) return null;

  try {
    const parsed: unknown = JSON.parse(answersJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const kept = Object.fromEntries(Object.entries(parsed).filter(([key]) => !piiKeys.has(key)));
    return Object.keys(kept).length === 0 ? null : JSON.stringify(kept);
  } catch {
    // Unparseable answers cannot be filtered safely, so they go entirely.
    return null;
  }
}
