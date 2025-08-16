/**
 * Auth Schemas
 * Validation schemas specific to authentication
 */

import { z } from 'zod';
import {
  PasswordSchema,
  RoleSchema,
  UsernameSchema,
  UUIDSchema
} from '../../shared/schemas/base.js';

// Login request schema
export const LoginSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema
});

// Auth response schema (JWT token data)
export const AuthResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: UUIDSchema,
    username: z.string(),
    name: z.string(),
    role: RoleSchema
  }),
  expiresIn: z.string().default('24h')
});

// JWT payload schema
export const JWTPayloadSchema = z.object({
  userId: UUIDSchema,
  username: z.string(),
  role: RoleSchema,
  iat: z.number(),
  exp: z.number()
});

// Token refresh schema
export const TokenRefreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
});

// Password reset request schema
export const PasswordResetRequestSchema = z.object({
  username: UsernameSchema
});

// Password reset schema
export const PasswordResetSchema = z
  .object({
    token: z.string().min(1, 'Reset token is required'),
    newPassword: PasswordSchema,
    confirmPassword: PasswordSchema
  })
  .refine(data => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword']
  });

// Session validation schema
export const SessionValidationSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  checkExpiry: z.boolean().default(true)
});
