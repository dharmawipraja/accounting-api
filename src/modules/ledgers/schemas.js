/**
 * Ledgers Schemas
 * Validation schemas for ledger operations
 */

import { z } from 'zod';
import {
  DateSchema,
  LedgerTypeSchema,
  PaginationSchema,
  PositiveDecimalSchema,
  PostingStatusSchema,
  TimestampSchema,
  TransactionTypeSchema,
  UUIDSchema
} from '../../shared/schemas/base.js';
import { QueryFiltersSchema } from '../../shared/schemas/common.js';

// Single ledger item for bulk creation
export const LedgerItemSchema = z.object({
  amount: PositiveDecimalSchema,
  description: z
    .string()
    .min(3, 'Description must be at least 3 characters')
    .max(500, 'Description must be less than 500 characters')
    .trim(),
  accountDetailId: UUIDSchema,
  accountGeneralId: UUIDSchema,
  ledgerType: LedgerTypeSchema,
  transactionType: TransactionTypeSchema,
  ledgerDate: DateSchema
});

// Bulk ledger creation schema
export const LedgerBulkCreateSchema = z.object({
  ledgers: z
    .array(LedgerItemSchema)
    .min(1, 'At least one ledger entry is required')
    .max(100, 'Maximum 100 ledger entries allowed per batch')
});

// Single ledger creation schema
export const LedgerCreateSchema = LedgerItemSchema.extend({
  referenceNumber: z
    .string()
    .min(1, 'Reference number is required')
    .max(50, 'Reference number must be less than 50 characters')
    .regex(/^[A-Z0-9\-]+$/i, 'Reference number must be alphanumeric with hyphens only')
    .trim()
});

// Ledger update schema
export const LedgerUpdateSchema = LedgerItemSchema.partial().extend({
  postingStatus: PostingStatusSchema.optional()
});

// Ledger response schema
export const LedgerResponseSchema = z
  .object({
    id: UUIDSchema,
    referenceNumber: z.string(),
    amount: z.number(),
    description: z.string(),
    ledgerType: LedgerTypeSchema,
    transactionType: TransactionTypeSchema,
    postingStatus: PostingStatusSchema,
    ledgerDate: DateSchema,
    postingAt: z.date().nullable().optional(),
    accountDetailId: UUIDSchema,
    accountGeneralId: UUIDSchema,
    createdBy: z.string(),
    updatedBy: z.string(),
    accountDetail: z
      .object({
        id: UUIDSchema,
        accountNumber: z.string(),
        accountName: z.string()
      })
      .optional(),
    accountGeneral: z
      .object({
        id: UUIDSchema,
        accountNumber: z.string(),
        accountName: z.string()
      })
      .optional()
  })
  .merge(TimestampSchema);

// Ledger query schema
// Enhanced ledger query schema with advanced filtering
export const LedgerQuerySchema = PaginationSchema.extend({
  accountDetailId: UUIDSchema.optional(),
  accountGeneralId: UUIDSchema.optional(),
  ledgerType: LedgerTypeSchema.optional(),
  transactionType: TransactionTypeSchema.optional(),
  postingStatus: PostingStatusSchema.optional(),
  dateFrom: DateSchema.optional(),
  dateTo: DateSchema.optional(),
  amountFrom: PositiveDecimalSchema.optional(),
  amountTo: PositiveDecimalSchema.optional(),
  search: z.string().max(100).optional()
}).merge(QueryFiltersSchema);

// Ledger reconciliation schema
export const LedgerReconciliationSchema = z.object({
  ledgerIds: z.array(UUIDSchema).min(1).max(1000),
  reconciliationDate: DateSchema,
  notes: z.string().max(1000).optional()
});

// Ledger posting schema
export const LedgerPostingSchema = z.object({
  ledgerIds: z.array(UUIDSchema).min(1).max(100),
  postingDate: DateSchema.optional(),
  notes: z.string().max(500).optional()
});

// Ledger report schema
export const LedgerReportSchema = z.object({
  reportType: z.enum(['TRIAL_BALANCE', 'GENERAL_LEDGER', 'ACCOUNT_SUMMARY']),
  dateFrom: DateSchema,
  dateTo: DateSchema,
  accountIds: z.array(UUIDSchema).optional(),
  format: z.enum(['JSON', 'CSV', 'PDF']).default('JSON'),
  includeUnposted: z.boolean().default(false)
});
