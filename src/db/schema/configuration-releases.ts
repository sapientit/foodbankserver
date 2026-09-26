import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/**
 * `draft → published → superseded`, and `superseded → published` again by a
 * rollback. There is no way back to `draft` and no deleting one.
 */
export const CONFIGURATION_RELEASE_STATUSES = ['draft', 'published', 'superseded'] as const;
export type ConfigurationReleaseStatus = (typeof CONFIGURATION_RELEASE_STATUSES)[number];

/**
 * One release of the referral form and its preference rules, together. See
 * `INITIAL_SPEC1.txt`, `#referral`.
 *
 * **The server stores both JSON documents and never reads them.** They are
 * `TEXT` holding exactly the characters the uploader sent — not parsed, not
 * re-serialised — so the uploader's hashes still describe what is stored. The
 * hashes are kept for audit and are not recomputed or checked here.
 *
 * **Content is immutable after insert.** Only `status` and the two
 * `published_*` columns ever change, and the repository has no statement that
 * updates anything else.
 *
 * **Exactly one row is `published`.** The partial unique index is what holds
 * that under two administrators publishing at once, not the service; publish
 * and rollback swap the pointer in one batch so no reader sees zero or two.
 *
 * `published_at` / `published_by_user_id` record the *most recent* publish —
 * a rollback overwrites them. The full history is
 * `configuration_release_publications`.
 */
export const configurationReleases = sqliteTable(
  'configuration_releases',
  {
    id: text('id').primaryKey(),
    questionnaireJson: text('questionnaire_json').notNull(),
    rulesJson: text('rules_json').notNull(),
    questionnaireHash: text('questionnaire_hash').notNull(),
    rulesHash: text('rules_hash').notNull(),
    generationId: text('generation_id').notNull(),
    generatedAt: text('generated_at').notNull(),
    sourceWorkbookId: text('source_workbook_id').notNull(),
    status: text('status').$type<ConfigurationReleaseStatus>().notNull(),
    createdAt: text('created_at').notNull(),
    /** Null only for the baseline release migration `0040` seeded, which nobody uploaded. */
    createdByUserId: text('created_by_user_id').references(() => users.id),
    publishedAt: text('published_at'),
    publishedByUserId: text('published_by_user_id').references(() => users.id),
  },
  (table) => [
    uniqueIndex('uq_configuration_releases_one_published')
      .on(table.status)
      .where(sql`${table.status} = 'published'`),
    index('idx_configuration_releases_created_at').on(table.createdAt),
    check(
      'configuration_releases_status_valid',
      sql`${table.status} IN ('draft', 'published', 'superseded')`,
    ),
  ],
);

export const CONFIGURATION_RELEASE_ACTIONS = ['publish', 'rollback'] as const;
export type ConfigurationReleaseAction = (typeof CONFIGURATION_RELEASE_ACTIONS)[number];

/**
 * Every time a release became the one in use, and who did it. Append-only:
 * written in the same batch as the pointer swap, never updated or deleted.
 * A rollback is recorded as one, distinct from a publish, though it moves the
 * pointer the same way.
 */
export const configurationReleasePublications = sqliteTable(
  'configuration_release_publications',
  {
    id: text('id').primaryKey(),
    releaseId: text('release_id')
      .notNull()
      .references(() => configurationReleases.id),
    action: text('action').$type<ConfigurationReleaseAction>().notNull(),
    occurredAt: text('occurred_at').notNull(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index('idx_configuration_release_publications_release').on(table.releaseId),
    check(
      'configuration_release_publications_action_valid',
      sql`${table.action} IN ('publish', 'rollback')`,
    ),
  ],
);

export type ConfigurationRelease = typeof configurationReleases.$inferSelect;
export type NewConfigurationRelease = typeof configurationReleases.$inferInsert;
export type NewConfigurationReleasePublication =
  typeof configurationReleasePublications.$inferInsert;
