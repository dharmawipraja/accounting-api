/**
 * Users Sc} from '../../shared/schemas/base.js';
import { QueryFiltersSchema, BulkOperationSchema } from '../../shared/schemas/common.js';

// User creation schemaion schemas for user operations
 */

import { z } from 'zod';
import {
  NameSchema,
  PaginationSchema,
  PasswordSchema,
  RoleSchema,
  TimestampSchema,
  UsernameSchema,
  UserStatusSchema,
  UUIDSchema
} from '../../shared/schemas/base.js';
import { BulkOperationSchema, QueryFiltersSchema } from '../../shared/schemas/common.js';

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

// Enhanced User query schema for filtering and pagination
export const UserQuerySchema = PaginationSchema.extend({
  search: z.string().optional(),
  role: RoleSchema.optional(),
  status: UserStatusSchema.optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  includeInactive: z.boolean().default(false)
}).merge(QueryFiltersSchema);

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

// User profile update schema
export const UserProfileUpdateSchema = z.object({
  name: NameSchema.optional(),
  preferences: z.record(z.any()).optional(),
  settings: z
    .object({
      language: z.enum(['en', 'id']).optional(),
      timezone: z.string().optional(),
      theme: z.enum(['light', 'dark', 'auto']).optional()
    })
    .optional()
});

// User bulk operation schema
export const UserBulkOperationSchema = BulkOperationSchema.extend({
  items: z.array(z.union([UserCreateSchema, UserUpdateSchema.extend({ id: UUIDSchema })]))
});

// User activity log schema
export const UserActivitySchema = z.object({
  userId: UUIDSchema,
  action: z.string(),
  resource: z.string().optional(),
  resourceId: UUIDSchema.optional(),
  metadata: z.record(z.any()).optional(),
  ipAddress: z
    .string()
    .regex(
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4})$/,
      'Invalid IP address'
    )
    .optional(),
  userAgent: z.string().optional()
});
