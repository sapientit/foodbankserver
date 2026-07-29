import type { ZodType } from 'zod';
import type { Context } from 'hono';
import { BadRequestError } from '../core/errors.ts';
import type { AppEnv } from './types.ts';

/**
 * Validation at the edge, once.
 *
 * Failures report the field path and the rule that failed, never the value
 * that failed it — echoing input back would put a referee's name or address
 * into an error message, and error messages get logged.
 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw new BadRequestError('Request validation failed', {
    details: {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
}

/** Parses a JSON body, turning malformed JSON into a 400 rather than a 500. */
export async function parseJsonBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  return parseOrThrow(schema, await readJson(c, false));
}

/** As above, but treats an empty body as `{}` — for POSTs where fields are optional. */
export async function parseOptionalJsonBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  return parseOrThrow(schema, await readJson(c, true));
}

async function readJson(c: Context<AppEnv>, allowEmpty: boolean): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') {
    if (allowEmpty) return {};
    throw new BadRequestError('Request body is required');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError('Request body is not valid JSON');
  }
}
