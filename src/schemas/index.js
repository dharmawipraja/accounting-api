/**
 * Zod Validation Schemas
 *
 * Centralized validation schemas for the accounting API using Zod.
 * Provides type-safe validation with better error messages and TypeScript integration.
 */

import { z } from 'zod';

// =================
// Enum Schemas
// =================

export const AccountCategorySchema = z.enum(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA']);

export const AccountTypeSchema = z.enum(['GENERAL', 'DETAIL']);

export const LedgerTypeSchema = z.enum(['KAS_MASUK', 'KAS_KELUAR']);

export const PostingStatusSchema = z.enum(['PENDING', 'POSTED']);

export const ReportTypeSchema = z.enum(['NERACA', 'LABA_RUGI']);

export const RoleSchema = z.enum(['NASABAH', 'KASIR', 'KOLEKTOR', 'MANAJER', 'ADMIN', 'AKUNTAN']);

export const TransactionTypeSchema = z.enum(['DEBIT', 'CREDIT']);

export const UserStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);

// =================
// Base Schemas
// =================

// IDs use ULID (26-character Crockford Base32). We accept ULID values (case-insensitive).
// NOTE: existing data using other id formats must be migrated to ULID for validation to pass.
export const UUIDSchema = z
  .string()
  .length(26, 'Invalid ID length; expected ULID (26 chars)')
  // Crockford Base32 (no I, L, O, U) - allow case-insensitive match
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, 'Invalid ULID format');

export const PositiveDecimalSchema = z
  .number()
  .positive('Amount must be positive')
  .max(99999999.99, 'Amount too large')
  .multipleOf(0.01, 'Amount must have at most 2 decimal places');

export const DateSchema = z.coerce.date();

export const OptionalDateSchema = z.coerce.date().optional();

// =================
// Pagination Schema
// =================

export const PaginationSchema = z.object({
  page: z
    .string()
    .or(z.number())
    .optional()
    .transform(val => (val ? parseInt(String(val)) : 1))
    .refine(val => val >= 1, 'Page must be >= 1'),
  limit: z
    .string()
    .or(z.number())
    .optional()
    .transform(val => (val ? parseInt(String(val)) : 10))
    .refine(val => val >= 1 && val <= 100, 'Limit must be between 1 and 100')
});

// =================
// Authentication Schemas
// =================

export const LoginSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be less than 50 characters'),
  password: z.string().min(1, 'Password is required')
});

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: UUIDSchema,
    username: z.string(),
    name: z.string(),
    role: RoleSchema
  }),
  expiresIn: z.string()
});

// =================
// User Schemas
// =================

export const UserCreateSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be less than 50 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100, 'Password must be less than 100 characters'),
  name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must be less than 100 characters')
    .trim(),
  role: RoleSchema.default('NASABAH'),
  status: UserStatusSchema.default('ACTIVE')
});

export const UserUpdateSchema = UserCreateSchema.partial().omit({ username: true });

export const UserResponseSchema = z.object({
  id: UUIDSchema,
  username: z.string(),
  name: z.string(),
  role: RoleSchema,
  status: UserStatusSchema,
  createdAt: DateSchema,
  updatedAt: DateSchema
});

// =================
// Account Schemas
// =================

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
  amountDebit: PositiveDecimalSchema.default(0),
  createdBy: UUIDSchema,
  updatedBy: UUIDSchema
});

export const AccountGeneralUpdateSchema = AccountGeneralCreateSchema.partial().omit({
  accountNumber: true,
  createdBy: true
});

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
  accountGeneralId: UUIDSchema,
  accountCategory: AccountCategorySchema,
  reportType: ReportTypeSchema,
  transactionType: TransactionTypeSchema,
  amountCredit: PositiveDecimalSchema.default(0),
  amountDebit: PositiveDecimalSchema.default(0),
  createdBy: UUIDSchema,
  updatedBy: UUIDSchema
});

export const AccountDetailUpdateSchema = AccountDetailCreateSchema.partial().omit({
  accountNumber: true,
  createdBy: true,
  accountGeneralId: true
});

export const AccountResponseSchema = z.object({
  id: UUIDSchema,
  accountNumber: z.string(),
  accountName: z.string(),
  accountType: AccountTypeSchema,
  accountCategory: AccountCategorySchema,
  reportType: ReportTypeSchema,
  transactionType: TransactionTypeSchema,
  amountCredit: z.number(),
  amountDebit: z.number(),
  createdAt: DateSchema,
  updatedAt: DateSchema,
  createdBy: z.string(),
  updatedBy: z.string(),
  deletedAt: OptionalDateSchema
});

// =================
// Ledger Schemas
// =================

// Single ledger item for bulk creation (no referenceNumber as it will be generated)
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

// Bulk ledger creation schema (array of ledger items)
export const LedgerBulkCreateSchema = z.object({
  ledgers: z
    .array(LedgerItemSchema)
    .min(1, 'At least one ledger entry is required')
    .max(100, 'Maximum 100 ledger entries allowed per batch')
});

// Single ledger creation schema (for individual creation if needed)
export const LedgerCreateSchema = LedgerItemSchema.extend({
  referenceNumber: z
    .string()
    .min(1, 'Reference number is required')
    .max(50, 'Reference number must be less than 50 characters')
    .regex(/^[A-Z0-9]+$/, 'Reference number must be uppercase alphanumeric only')
    .trim()
});

export const LedgerUpdateSchema = LedgerItemSchema.partial();

export const LedgerResponseSchema = z.object({
  id: UUIDSchema,
  referenceNumber: z.string(),
  amount: z.number(),
  description: z.string(),
  ledgerType: LedgerTypeSchema,
  transactionType: TransactionTypeSchema,
  postingStatus: PostingStatusSchema,
  ledgerDate: DateSchema,
  postingAt: OptionalDateSchema,
  createdAt: DateSchema,
  updatedAt: DateSchema,
  createdBy: z.string(),
  updatedBy: z.string(),
  deletedAt: OptionalDateSchema,
  accountDetailId: z.string(),
  accountGeneralId: z.string()
});

// Posting status update schemas
export const LedgerPostingSchema = z.object({
  postingStatus: PostingStatusSchema
});

// =================
// Balance Schemas
// =================

export const BalanceCreateSchema = z.object({
  amount: PositiveDecimalSchema,
  createdBy: UUIDSchema,
  updatedBy: UUIDSchema
});

export const BalanceUpdateSchema = BalanceCreateSchema.partial().omit({ createdBy: true });

export const BalanceResponseSchema = z.object({
  id: UUIDSchema,
  amount: z.number(),
  createdAt: DateSchema,
  updatedAt: DateSchema,
  createdBy: z.string(),
  updatedBy: z.string()
});

// =================
// Query Parameter Schemas
// =================

export const DateRangeQuerySchema = z.object({
  startDate: OptionalDateSchema,
  endDate: OptionalDateSchema
});

export const AccountQuerySchema = PaginationSchema.extend({
  search: z.string().optional(),
  accountCategory: AccountCategorySchema.optional(),
  accountType: AccountTypeSchema.optional(),
  ...DateRangeQuerySchema.shape
});

export const LedgerQuerySchema = PaginationSchema.extend({
  search: z.string().optional(),
  ledgerType: LedgerTypeSchema.optional(),
  transactionType: TransactionTypeSchema.optional(),
  postingStatus: PostingStatusSchema.optional(),
  accountDetailId: UUIDSchema.optional(),
  accountGeneralId: UUIDSchema.optional(),
  ...DateRangeQuerySchema.shape
}).refine(v => !(v.startDate && v.endDate) || v.startDate <= v.endDate, {
  message: 'startDate must be less than or equal to endDate',
  path: ['startDate']
});

export const UserQuerySchema = PaginationSchema.extend({
  search: z.string().optional(),
  role: RoleSchema.optional(),
  status: UserStatusSchema.optional()
});

// =================
// Common helpers
// =================

// Coerce boolean-like query values (true/false, 'true'/'false', '1'/'0', 1/0)
export const BooleanishSchema = z
  .union([z.boolean(), z.string(), z.number()])
  .optional()
  .transform(val => val === true || val === 'true' || val === '1' || val === 1);

// =================
// Response Wrapper Schemas
// =================

export const SuccessResponseSchema = dataSchema =>
  z.object({
    success: z.boolean().default(true),
    data: dataSchema,
    meta: z
      .object({
        timestamp: z.string(),
        pagination: z
          .object({
            page: z.number(),
            limit: z.number(),
            total: z.number(),
            totalPages: z.number(),
            hasNext: z.boolean(),
            hasPrev: z.boolean(),
            nextPage: z.number().nullable(),
            prevPage: z.number().nullable()
          })
          .optional()
      })
      .optional()
  });

export const ErrorResponseSchema = z.object({
  success: z.boolean().default(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.string()).optional(),
    requestId: z.string().optional()
  })
});

// =================
// ID Parameter Schema
// =================

export const IdParamSchema = z.object({
  id: UUIDSchema
});
