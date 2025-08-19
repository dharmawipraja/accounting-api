/**
 * Account Detail Schemas
 * Validation schemas for detailed account operations
 */

import { z } from 'zod';
import {
  AccountCategorySchema,
  AccountTypeSchema,
  BooleanishSchema,
  PaginationSchema,
  PositiveDecimalSchema,
  ReportTypeSchema,
  TimestampSchema,
  TransactionTypeSchema,
  UUIDSchema
} from '../../../shared/schemas/base.js';

// Account Detail creation schema
export const AccountDetailCreateSchema = z.object({
  accountNumber: z
    .string()
    .min(1, 'Account number is required')
    .max(20, 'Account number must be less than 20 characters')
    .regex(/^[0-9\-]+$/, 'Account number can only contain numbers and hyphens'),
  accountName: z
    .string()
    .min(3, 'Account name must be at least 3 characters')
    .max(100, 'Account name must be less than 100 characters')
    .trim(),
  accountGeneralId: z.string().min(1, 'Account general number is required'),
  accountCategory: AccountCategorySchema,
  reportType: ReportTypeSchema,
  transactionType: TransactionTypeSchema,
  amountCredit: PositiveDecimalSchema.default(0),
  amountDebit: PositiveDecimalSchema.default(0)
});

// Account Detail update schema
export const AccountDetailUpdateSchema = AccountDetailCreateSchema.partial().omit({
  accountNumber: true,
  accountGeneralId: true
});

// Account Detail response schema
export const AccountDetailResponseSchema = z
  .object({
    id: UUIDSchema,
    accountNumber: z.string(),
    accountName: z.string(),
    accountType: AccountTypeSchema.default('DETAIL'),
    accountCategory: AccountCategorySchema,
    reportType: ReportTypeSchema,
    transactionType: TransactionTypeSchema,
    amountCredit: z.number(),
    amountDebit: z.number(),
    accountGeneralAccountNumber: z.string(),
    createdBy: z.string(),
    updatedBy: z.string(),
    deletedAt: z.date().nullable().optional(),
    accountGeneral: z
      .object({
        id: UUIDSchema,
        accountNumber: z.string(),
        accountName: z.string()
      })
      .optional()
  })
  .merge(TimestampSchema);

// Account Detail query schema
export const AccountDetailQuerySchema = PaginationSchema.extend({
  search: z.string().optional(),
  accountCategory: AccountCategorySchema.optional(),
  reportType: ReportTypeSchema.optional(),
  transactionType: TransactionTypeSchema.optional(),
  accountGeneralId: UUIDSchema.optional(),
  includeDeleted: BooleanishSchema.default(false),
  includeLedgers: BooleanishSchema.default(false)
});
