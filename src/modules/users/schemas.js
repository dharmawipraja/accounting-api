/**
 * Users Schemas
 * Validation schemas for user operations
 */

import { z } from 'zod';
import {
  NameSchema,
  PaginationSchema,
  PasswordSchema,
  RoleSchema,
  TimestampSchema,
  UUIDSchema,
  UserStatusSchema,
  UsernameSchema
} from '../../shared/schemas/base.js';

// User creation schema
export const UserCreateSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
  name: NameSchema,
  role: RoleSchema.default('NASABAH'),
  status: UserStatusSchema.default('ACTIVE')
});

// User update schema (password is optional for updates)
export const UserUpdateSchema = z.object({
  username: UsernameSchema.optional(),
  password: PasswordSchema.optional(),
  name: NameSchema.optional(),
  role: RoleSchema.optional(),
  status: UserStatusSchema.optional()
});

// User response schema (excludes password)
export const UserResponseSchema = z
  .object({
    id: UUIDSchema,
    username: z.string(),
    name: z.string(),
    role: RoleSchema,
    status: UserStatusSchema
  })
  .merge(TimestampSchema);

// User query schema for filtering and pagination
export const UserQuerySchema = PaginationSchema.extend({
  search: z.string().optional(),
  role: RoleSchema.optional(),
  status: UserStatusSchema.optional()
});

// Password change schema
export const PasswordChangeSchema = z
  .object({
    currentPassword: PasswordSchema,
    newPassword: PasswordSchema,
    confirmPassword: PasswordSchema
  })
  .refine(data => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword']
  });
