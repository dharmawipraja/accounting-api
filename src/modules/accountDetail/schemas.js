/**
 * Account Detail Schemas
 * Validation schemas for account detail operations
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

// Base account detail data schema
export const AccountDetailBaseSchema = z.object({
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
  accountGeneralAccountNumber: z
    .string()
    .trim()
    .min(1, 'Account general account number is required'),
  accountCategory: AccountCategorySchema,
  reportType: ReportTypeSchema,
  transactionType: TransactionTypeSchema,
  initialAmountCredit: z.number().default(0),
  initialAmountDebit: z.number().default(0)
});

// Account detail creation schema
export const AccountDetailCreateSchema = AccountDetailBaseSchema;

// Account detail update schema (all fields optional)
export const AccountDetailUpdateSchema = AccountDetailBaseSchema.partial();

// Account detail response schema
export const AccountDetailResponseSchema = z
  .object({
    id: UUIDSchema,
    accountNumber: z.string(),
    accountName: z.string(),
    accountType: AccountTypeSchema,
    accountGeneralAccountNumber: z.string(),
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

// Account detail query schema for filtering and pagination
export const AccountDetailQuerySchema = QueryFiltersSchema.extend({
  accountCategory: AccountCategorySchema.optional(),
  reportType: ReportTypeSchema.optional(),
  accountGeneralAccountNumber: z.string().optional(),
  search: z.string().trim().max(100).optional()
});

// Account detail with general account response schema
export const AccountDetailWithGeneralSchema = AccountDetailResponseSchema.extend({
  accountGeneral: z.object({
    id: UUIDSchema,
    accountNumber: z.string(),
    accountName: z.string(),
    accountCategory: AccountCategorySchema,
    reportType: ReportTypeSchema,
    transactionType: TransactionTypeSchema
  })
});
