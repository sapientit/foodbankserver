import type {
  ConfigurationRelease,
  ConfigurationReleaseStatus,
} from '../../db/schema/configuration-releases.ts';
import type { ConfigurationReleaseSummary } from './configuration-releases.repository.ts';

/**
 * Response mappers are the output allowlist.
 *
 * Hono has no response-schema mechanism, so this is what stops a newly added
 * column reaching a client that should not see it — adding a field to the
 * table must never widen an API response by accident.
 */

export interface ConfigurationReleaseResponse {
  readonly formId: string;
  readonly status: ConfigurationReleaseStatus;
  readonly questionnaire: string;
  readonly rules: string;
  readonly questionnaireHash: string;
  readonly rulesHash: string;
  readonly generationId: string;
  readonly generatedAt: string;
  readonly sourceWorkbookId: string;
  readonly createdAt: string;
  readonly createdByUserId: string | null;
  readonly publishedAt: string | null;
  readonly publishedByUserId: string | null;
}

/**
 * The full release, content included. `questionnaire` and `rules` are the
 * stored `TEXT` verbatim — a string field the client parses itself, never
 * parsed or re-serialised here. See `db/schema/configuration-releases.ts`.
 */
export function toConfigurationReleaseResponse(
  release: ConfigurationRelease,
): ConfigurationReleaseResponse {
  return {
    formId: release.id,
    status: release.status,
    questionnaire: release.questionnaireJson,
    rules: release.rulesJson,
    questionnaireHash: release.questionnaireHash,
    rulesHash: release.rulesHash,
    generationId: release.generationId,
    generatedAt: release.generatedAt,
    sourceWorkbookId: release.sourceWorkbookId,
    createdAt: release.createdAt,
    createdByUserId: release.createdByUserId,
    publishedAt: release.publishedAt,
    publishedByUserId: release.publishedByUserId,
  };
}

export type ConfigurationReleaseSummaryResponse = Omit<
  ConfigurationReleaseResponse,
  'questionnaire' | 'rules'
>;

/** The history list: everything about a release except its two documents. */
export function toConfigurationReleaseSummaryResponse(
  summary: ConfigurationReleaseSummary,
): ConfigurationReleaseSummaryResponse {
  return {
    formId: summary.id,
    status: summary.status,
    questionnaireHash: summary.questionnaireHash,
    rulesHash: summary.rulesHash,
    generationId: summary.generationId,
    generatedAt: summary.generatedAt,
    sourceWorkbookId: summary.sourceWorkbookId,
    createdAt: summary.createdAt,
    createdByUserId: summary.createdByUserId,
    publishedAt: summary.publishedAt,
    publishedByUserId: summary.publishedByUserId,
  };
}

/**
 * What a fuel administrator is given: a release without its `rules`. Their
 * one screen shows answers and needs the questions to label them; it never
 * evaluates a preference rule, so the rules are left out rather than nulled.
 */
export type ConfigurationReleaseQuestionnaireResponse = Omit<ConfigurationReleaseResponse, 'rules'>;

export function toConfigurationReleaseQuestionnaireResponse(
  release: ConfigurationRelease,
): ConfigurationReleaseQuestionnaireResponse {
  const { rules: _rules, ...withoutRules } = toConfigurationReleaseResponse(release);
  return withoutRules;
}

export interface PublicQuestionnaireResponse {
  readonly formId: string;
  readonly questionnaire: string;
}

/**
 * The unauthenticated view: the questionnaire only. `rules` never reaches
 * this mapper at all — not omitted here, absent from the type — because a
 * preference rule can describe things about a household nobody outside the
 * food bank should see coming.
 */
export function toPublicQuestionnaireResponse(
  release: ConfigurationRelease,
): PublicQuestionnaireResponse {
  return {
    formId: release.id,
    questionnaire: release.questionnaireJson,
  };
}
