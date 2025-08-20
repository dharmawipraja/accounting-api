/**
 * Account General Schemas
 * Validation schemas for account general operations
 */

import { z } from 'zod';
import { TimestampSchema, UUIDSchema } from '../../shared/schemas/base.js';
import { QueryFiltersSchema } from '../../shared/schemas/common.js';

// Account Category enum schema
export const AccountCategorySchema = z.enum(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA']);

// Account Type enum schema
export const AccountTypeSchema = z.enum(['GENERAL', 'DETAIL']);

// Report Type enum schema
export const ReportTypeSchema = z.enum(['NERACA', 'LABA_RUGI']);

// Transaction Type enum schema
export const TransactionTypeSchema = z.enum(['DEBIT', 'CREDIT']);

// Base account general data schema
export const AccountGeneralBaseSchema = z.object({
  accountNumber: z
    .string()
    .trim()
    .min(1, 'Account number is required')
    .max(20, 'Account number is too long'),
  accountName: z
    .string()
    .trim()
    .min(1, 'Account name is required')
    .max(100, 'Account name is too long'),
  accountCategory: AccountCategorySchema,
  reportType: ReportTypeSchema,
  transactionType: TransactionTypeSchema,
  initialAmountCredit: z.number().default(0),
  initialAmountDebit: z.number().default(0)
});

// Account general creation schema
export const AccountGeneralCreateSchema = AccountGeneralBaseSchema;

// Account general update schema (all fields optional)
export const AccountGeneralUpdateSchema = AccountGeneralBaseSchema.partial();

// Account general response schema
export const AccountGeneralResponseSchema = z
  .object({
    id: UUIDSchema,
    accountNumber: z.string(),
    accountName: z.string(),
    accountType: AccountTypeSchema,
    accountCategory: AccountCategorySchema,
    reportType: ReportTypeSchema,
    transactionType: TransactionTypeSchema,
    initialAmountCredit: z.number(),
    initialAmountDebit: z.number(),
    accumulationAmountCredit: z.number(),
    accumulationAmountDebit: z.number(),
    amountCredit: z.number(),
    amountDebit: z.number(),
    createdBy: z.string(),
    updatedBy: z.string(),
    deletedAt: z.date().nullable()
  })
  .merge(TimestampSchema);

// Account general query schema for filtering and pagination
export const AccountGeneralQuerySchema = QueryFiltersSchema.extend({
  accountCategory: AccountCategorySchema.optional(),
  reportType: ReportTypeSchema.optional(),
  search: z.string().trim().max(100).optional()
});

// Account general with details response schema
export const AccountGeneralWithDetailsSchema = AccountGeneralResponseSchema.extend({
  accountsDetail: z.array(
    z.object({
      id: UUIDSchema,
      accountNumber: z.string(),
      accountName: z.string(),
      amountDebit: z.number(),
      amountCredit: z.number()
    })
  )
});
