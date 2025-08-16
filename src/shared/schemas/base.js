/**
 * Base Zod Schemas
 * Fundamental validation schemas used across modules
 */

import { z } from 'zod';
import { PAGINATION, VALIDATION_LIMITS } from '../constants/index.js';

// =================
// ID Schemas
// =================

export const UUIDSchema = z
  .string()
  .length(VALIDATION_LIMITS.ULID_LENGTH, 'Invalid ID length; expected ULID (26 chars)')
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, 'Invalid ULID format');

export const IdParamSchema = z.object({
  id: UUIDSchema
});

// =================
// Numeric Schemas
// =================

export const PositiveDecimalSchema = z
  .number()
  .positive('Amount must be positive')
  .max(VALIDATION_LIMITS.MAX_AMOUNT, 'Amount too large')
  .multipleOf(0.01, 'Amount must have at most 2 decimal places');

export const NonNegativeDecimalSchema = z
  .number()
  .nonnegative('Amount must be non-negative')
  .max(VALIDATION_LIMITS.MAX_AMOUNT, 'Amount too large')
  .multipleOf(0.01, 'Amount must have at most 2 decimal places');

// =================
// Date Schemas
// =================

export const DateSchema = z.coerce.date();
export const OptionalDateSchema = z.coerce.date().optional();

// =================
// String Schemas
// =================

export const NonEmptyStringSchema = z.string().min(1, 'Field cannot be empty').trim();

export const UsernameSchema = z
  .string()
  .min(VALIDATION_LIMITS.USERNAME_MIN_LENGTH, 'Username must be at least 3 characters')
  .max(50, 'Username cannot exceed 50 characters')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens')
  .trim();

export const PasswordSchema = z
  .string()
  .min(VALIDATION_LIMITS.PASSWORD_MIN_LENGTH, 'Password must be at least 6 characters');

export const NameSchema = z
  .string()
  .min(VALIDATION_LIMITS.NAME_MIN_LENGTH, 'Name must be at least 2 characters')
  .max(100, 'Name cannot exceed 100 characters')
  .trim();

// =================
// Boolean Schemas
// =================

export const BooleanishSchema = z.union([z.boolean(), z.string(), z.number()]).transform(val => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  if (typeof val === 'number') return val !== 0;
  return false;
});

// =================
// Pagination Schemas
// =================

export const PaginationSchema = z.object({
  limit: z
    .number()
    .int()
    .min(PAGINATION.MIN_LIMIT)
    .max(PAGINATION.MAX_LIMIT)
    .default(PAGINATION.DEFAULT_LIMIT)
    .optional(),
  skip: z.number().int().min(0).default(0).optional(),
  page: z.number().int().min(1).default(1).optional()
});

// =================
// Search Schema
// =================

export const SearchSchema = z.object({
  search: z.string().optional()
});

// =================
// Response Schemas
// =================

export const SuccessResponseSchema = dataSchema =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
    message: z.string().optional()
  });

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  statusCode: z.number(),
  details: z.record(z.any()).optional()
});

export const PaginatedResponseSchema = dataSchema =>
  z.object({
    success: z.literal(true),
    data: z.array(dataSchema),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      pages: z.number()
    }),
    message: z.string().optional()
  });

// =================
// Domain Schemas
// =================

export const RoleSchema = z.enum(['NASABAH', 'KASIR', 'KOLEKTOR', 'MANAJER', 'ADMIN', 'AKUNTAN']);

export const UserStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);

export const AccountCategorySchema = z.enum(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA']);

export const AccountTypeSchema = z.enum(['GENERAL', 'DETAIL']);

export const TransactionTypeSchema = z.enum(['DEBIT', 'CREDIT']);

export const LedgerTypeSchema = z.enum(['KAS_MASUK', 'KAS_KELUAR']);

export const PostingStatusSchema = z.enum(['POSTED', 'UNPOSTED']);

export const ReportTypeSchema = z.enum(['NERACA', 'LABA_RUGI']);

export const TimestampSchema = z.string().datetime();
