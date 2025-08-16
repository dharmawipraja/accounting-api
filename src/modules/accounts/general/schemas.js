/**
 * Account General Schemas
 * Validation schemas for general account operations
 */

import { z } from 'zod';
import {
  AccountCategorySchema,
  AccountTypeSchema,
  PaginationSchema,
  PositiveDecimalSchema,
  ReportTypeSchema,
  TimestampSchema,
  TransactionTypeSchema,
  UUIDSchema
} from '../../../shared/schemas/base.js';
import { BulkOperationSchema, QueryFiltersSchema } from '../../../shared/schemas/common.js';

// Account General creation schema
export const AccountGeneralCreateSchema = z.object({
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
  accountCategory: AccountCategorySchema,
  reportType: ReportTypeSchema,
  transactionType: TransactionTypeSchema,
  amountCredit: PositiveDecimalSchema.default(0),
  amountDebit: PositiveDecimalSchema.default(0)
});

// Account General update schema
export const AccountGeneralUpdateSchema = AccountGeneralCreateSchema.partial().omit({
  accountNumber: true
});

// Account General response schema
export const AccountGeneralResponseSchema = z
  .object({
    id: UUIDSchema,
    accountNumber: z.string(),
    accountName: z.string(),
    accountType: AccountTypeSchema.default('GENERAL'),
    accountCategory: AccountCategorySchema,
    reportType: ReportTypeSchema,
    transactionType: TransactionTypeSchema,
    amountCredit: z.number(),
    amountDebit: z.number(),
    createdBy: z.string(),
    updatedBy: z.string(),
    deletedAt: z.date().nullable().optional()
  })
  .merge(TimestampSchema);

// Enhanced Account General query schema with advanced filtering
export const AccountGeneralQuerySchema = PaginationSchema.extend({
  search: z.string().optional(),
  accountCategory: AccountCategorySchema.optional(),
  reportType: ReportTypeSchema.optional(),
  includeDeleted: z.boolean().default(false),
  accountNumberPrefix: z.string().optional(),
  hasDetails: z.boolean().optional()
}).merge(QueryFiltersSchema);

// Account hierarchy schema
export const AccountHierarchySchema = z.object({
  parentAccountId: UUIDSchema.optional(),
  includeChildren: z.boolean().default(true),
  maxDepth: z.number().int().min(1).max(10).default(5)
});

// Account bulk operations schema
export const AccountBulkOperationSchema = BulkOperationSchema.extend({
  items: z.array(
    z.union([AccountGeneralCreateSchema, AccountGeneralUpdateSchema.extend({ id: UUIDSchema })])
  )
});
