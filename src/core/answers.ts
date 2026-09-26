/**
 * Parses a referral's dynamic answers blob, defensively.
 *
 * The server keeps the form's releases but never reads them, so it has no
 * definition for it and stores whatever was sent. A blob that fails to parse, or that
 * parses to something other than a plain object, must not take a response
 * down; it becomes an empty answer set instead.
 */
export function parseAnswers(answersJson: string | null): Record<string, unknown> {
  if (answersJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(answersJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
