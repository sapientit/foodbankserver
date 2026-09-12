import { z } from 'zod';
import { isPlainDate } from '../../core/time/plain-date.ts';

const plainDate = z.string().refine(isPlainDate, 'must be a real YYYY-MM-DD date');

export const usageReportQuerySchema = z
  .object({
    from: plainDate,
    to: plainDate,
  })
  .refine((value) => value.from <= value.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });

export type UsageReportQuery = z.infer<typeof usageReportQuerySchema>;
