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
export const LedgerQuerySchema = PaginationSchema.extend({
  search: z.string().optional(),
  referenceNumber: z.string().optional(),
  ledgerType: LedgerTypeSchema.optional(),
  transactionType: TransactionTypeSchema.optional(),
  postingStatus: PostingStatusSchema.optional(),
  accountDetailId: UUIDSchema.optional(),
  accountGeneralId: UUIDSchema.optional(),
  startDate: DateSchema.optional(),
  endDate: DateSchema.optional(),
  includeAccounts: z.boolean().default(false)
});
