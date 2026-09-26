import { and, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  configurationReleasePublications,
  configurationReleases,
  type ConfigurationRelease,
  type ConfigurationReleaseAction,
  type ConfigurationReleaseStatus,
  type NewConfigurationRelease,
} from '../../db/schema/configuration-releases.ts';

/** A release without its two JSON documents — what the history list reads. */
export type ConfigurationReleaseSummary = Omit<
  ConfigurationRelease,
  'questionnaireJson' | 'rulesJson'
>;

/**
 * Deliberately no statement that updates `questionnaire_json`, `rules_json`,
 * the hashes or the generation columns: content is immutable after insert, and
 * the only way to make that true is for no code path to be able to do it.
 */
export function createConfigurationReleasesRepository(db: Database) {
  return {
    async findById(id: string): Promise<ConfigurationRelease | undefined> {
      const rows = await db
        .select()
        .from(configurationReleases)
        .where(eq(configurationReleases.id, id))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /** The release in use. The partial unique index means at most one. */
    async findPublished(): Promise<ConfigurationRelease | undefined> {
      const rows = await db
        .select()
        .from(configurationReleases)
        .where(eq(configurationReleases.status, 'published'))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /** Just the id of the release in use, without reading either document. */
    async findPublishedId(): Promise<string | undefined> {
      const rows = await db
        .select({ id: configurationReleases.id })
        .from(configurationReleases)
        .where(eq(configurationReleases.status, 'published'))
        .limit(1);
      return expectAtMostOne(rows)?.id;
    },

    /** One statement, one bound parameter per id; the caller caps the count well under 100. */
    async findManyByIds(ids: readonly string[]): Promise<ConfigurationRelease[]> {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(configurationReleases)
        .where(inArray(configurationReleases.id, [...ids]));
    },

    /** Every release, newest first, without its content. */
    async listSummaries(): Promise<ConfigurationReleaseSummary[]> {
      return db
        .select({
          id: configurationReleases.id,
          questionnaireHash: configurationReleases.questionnaireHash,
          rulesHash: configurationReleases.rulesHash,
          generationId: configurationReleases.generationId,
          generatedAt: configurationReleases.generatedAt,
          sourceWorkbookId: configurationReleases.sourceWorkbookId,
          status: configurationReleases.status,
          createdAt: configurationReleases.createdAt,
          createdByUserId: configurationReleases.createdByUserId,
          publishedAt: configurationReleases.publishedAt,
          publishedByUserId: configurationReleases.publishedByUserId,
        })
        .from(configurationReleases)
        .orderBy(desc(configurationReleases.createdAt), desc(configurationReleases.id));
    },

    async insert(value: NewConfigurationRelease): Promise<ConfigurationRelease> {
      const rows = await db.insert(configurationReleases).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert configuration release');
      return inserted;
    },

    // ---- Statement builders. Compose these, then run ONE db.batch(). ----

    /**
     * The three statements that make `targetId` the release in use, all
     * guarded on the target still being in `requiredStatus` when the batch
     * runs — the check travels with the writes, because D1 cannot read,
     * decide, then write atomically.
     *
     * Order matters. The publication row is written **first**, while the
     * target's status is still the one being checked, so it is recorded
     * exactly when the swap happens and never for a swap that did not. The
     * supersede touches only the `published` row, which is never the target
     * (`requiredStatus` is never `published`), so the guard reads the same
     * for all three. The supersede comes before the promote so the partial
     * unique index never sees two published rows.
     *
     * If the target is not in `requiredStatus`, all three change nothing and
     * the promote returns no row — the service's signal for a `409`.
     */
    buildPointerSwap(input: {
      readonly targetId: string;
      readonly requiredStatus: Exclude<ConfigurationReleaseStatus, 'published'>;
      readonly action: ConfigurationReleaseAction;
      readonly publicationId: string;
      readonly actorUserId: string;
      readonly at: string;
    }) {
      const target = alias(configurationReleases, 'target');
      const targetIsReady = exists(
        db
          .select({ one: sql`1` })
          .from(target)
          .where(and(eq(target.id, input.targetId), eq(target.status, input.requiredStatus))),
      );

      const recordPublication = db.insert(configurationReleasePublications).select(
        db
          .select({
            id: sql<string>`${input.publicationId}`.as('id'),
            releaseId: configurationReleases.id,
            action: sql<ConfigurationReleaseAction>`${input.action}`.as('action'),
            occurredAt: sql<string>`${input.at}`.as('occurred_at'),
            actorUserId: sql<string>`${input.actorUserId}`.as('actor_user_id'),
          })
          .from(configurationReleases)
          .where(
            and(
              eq(configurationReleases.id, input.targetId),
              eq(configurationReleases.status, input.requiredStatus),
            ),
          ),
      );

      const supersedeCurrent = db
        .update(configurationReleases)
        .set({ status: 'superseded' })
        .where(and(eq(configurationReleases.status, 'published'), targetIsReady));

      const promoteTarget = db
        .update(configurationReleases)
        .set({ status: 'published', publishedAt: input.at, publishedByUserId: input.actorUserId })
        .where(
          and(
            eq(configurationReleases.id, input.targetId),
            eq(configurationReleases.status, input.requiredStatus),
          ),
        )
        .returning({ id: configurationReleases.id });

      return [recordPublication, supersedeCurrent, promoteTarget] as const;
    },
  };
}

export type ConfigurationReleasesRepository = ReturnType<
  typeof createConfigurationReleasesRepository
>;
