import { z } from 'zod';
import { isPlainDate } from '../../core/time/plain-date.ts';

const plainDate = z.string().refine(isPlainDate, 'must be a real YYYY-MM-DD date');

/** `PUT /voucher-config` — saved whole, like `PUT /parcel-grid`. */
export const voucherConfigSchema = z
  .object({
    startDate: plainDate,
    endDate: plainDate,
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'endDate must not be before startDate',
    path: ['endDate'],
  });

export type VoucherConfigInput = z.infer<typeof voucherConfigSchema>;
