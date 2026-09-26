import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors.ts';
import type { Database } from '../../db/client.ts';
import type {
  ConfigurationRelease,
  ConfigurationReleaseAction,
  ConfigurationReleaseStatus,
} from '../../db/schema/configuration-releases.ts';
import type {
  ConfigurationReleaseSummary,
  ConfigurationReleasesRepository,
} from './configuration-releases.repository.ts';

export interface ConfigurationReleasesServiceDeps {
  readonly db: Database;
  readonly repository: ConfigurationReleasesRepository;
  readonly clock: Clock;
}

/** What an upload carries: the two documents as sent, and the uploader's manifest. */
export interface ConfigurationReleaseUpload {
  readonly questionnaire: string;
  readonly rules: string;
  readonly questionnaireHash: string;
  readonly rulesHash: string;
  readonly generationId: string;
  readonly generatedAt: string;
  readonly sourceWorkbookId: string;
}

/**
 * The referral form and its preference rules as versioned releases.
 * `INITIAL_SPEC1.txt`, `#referral`.
 *
 * **Nothing here reads a release.** An upload is stored as sent and a publish
 * checks only which state the target row is in. Checking a release is the
 * uploader's job before it is sent and the client's when it loads one; the
 * server is a store, and a check here would be the server deciding what a
 * valid form is — which is exactly what it gave up in migration `0008`.
 */
export function createConfigurationReleasesService(deps: ConfigurationReleasesServiceDeps) {
  const { db, repository, clock } = deps;

  /**
   * Publish and rollback are one operation with two preconditions: the same
   * pointer swap, one batch, a different status the target must be in and a
   * different label on the publication row. A superseded release comes back
   * only through rollback, never publish.
   */
  async function makeCurrent(
    formId: string,
    requiredStatus: Exclude<ConfigurationReleaseStatus, 'published'>,
    action: ConfigurationReleaseAction,
    actor: Actor,
  ): Promise<ConfigurationRelease> {
    const existing = await repository.findById(formId);
    if (existing === undefined) {
      throw new NotFoundError('Configuration release not found');
    }
    if (existing.status !== requiredStatus) {
      throw new ConflictError(
        action === 'publish'
          ? `Only a draft release can be published; this one is ${existing.status}`
          : `Only a superseded release can be rolled back to; this one is ${existing.status}`,
      );
    }

    const now = clock.nowIso();
    const [recordPublication, supersedeCurrent, promoteTarget] = repository.buildPointerSwap({
      targetId: formId,
      requiredStatus,
      action,
      publicationId: crypto.randomUUID(),
      actorUserId: actor.userId,
      at: now,
    });
    const [, , promoted] = await db.batch([recordPublication, supersedeCurrent, promoteTarget]);

    // The read above can be stale: another administrator may have moved this
    // release between it and the batch. The guarded batch then changed
    // nothing, and says so by promoting no row.
    if (promoted.length === 0) {
      throw new ConflictError('That release changed state while this request was being made');
    }

    return {
      ...existing,
      status: 'published',
      publishedAt: now,
      publishedByUserId: actor.userId,
    };
  }

  return {
    /** Stores an uploaded release as a draft, exactly as sent. */
    async upload(input: ConfigurationReleaseUpload, actor: Actor): Promise<ConfigurationRelease> {
      return repository.insert({
        id: crypto.randomUUID(),
        questionnaireJson: input.questionnaire,
        rulesJson: input.rules,
        questionnaireHash: input.questionnaireHash,
        rulesHash: input.rulesHash,
        generationId: input.generationId,
        generatedAt: input.generatedAt,
        sourceWorkbookId: input.sourceWorkbookId,
        status: 'draft',
        createdAt: clock.nowIso(),
        createdByUserId: actor.userId,
        publishedAt: null,
        publishedByUserId: null,
      });
    },

    async publish(formId: string, actor: Actor): Promise<ConfigurationRelease> {
      return makeCurrent(formId, 'draft', 'publish', actor);
    },

    async rollback(formId: string, actor: Actor): Promise<ConfigurationRelease> {
      return makeCurrent(formId, 'superseded', 'rollback', actor);
    },

    async history(): Promise<ConfigurationReleaseSummary[]> {
      return repository.listSummaries();
    },

    /** The releases asked for, in any status. An unknown id is left out rather than failing the call. */
    async findMany(formIds: readonly string[]): Promise<ConfigurationRelease[]> {
      return repository.findManyByIds(formIds);
    },

    /** The release in use, for the public form. */
    async current(): Promise<ConfigurationRelease> {
      const release = await repository.findPublished();
      if (release === undefined) {
        throw new NotFoundError('No referral form has been published');
      }
      return release;
    },

    /**
     * The id of the release in use, which a referral made without naming one
     * is recorded under. Migration `0040` seeds one and nothing can take it
     * away, so its absence is a broken invariant rather than a client error.
     */
    async currentFormId(): Promise<string> {
      const id = await repository.findPublishedId();
      if (id === undefined) {
        throw new Error('No configuration release is published');
      }
      return id;
    },

    /**
     * A referral may name the release in use or one retired since — a form
     * loaded just before a publish is still a real form. A draft never: nothing
     * public can have been shown one.
     */
    async assertSubmittable(formId: string): Promise<void> {
      const release = await repository.findById(formId);
      if (release === undefined || release.status === 'draft') {
        throw new UnprocessableError('formId does not name a published referral form');
      }
    },
  };
}

export type ConfigurationReleasesService = ReturnType<typeof createConfigurationReleasesService>;
