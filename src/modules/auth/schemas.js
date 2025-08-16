/**
 * Auth Schemas
 * Validation schemas specific to authentication
 */

import { z } from 'zod';
import { PasswordSchema, RoleSchema, UsernameSchema } from '../../shared/schemas/base.js';

// Login request schema
export const LoginSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema
});

// Auth response schema (JWT token data)
export const AuthResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    username: z.string(),
    name: z.string(),
    role: RoleSchema
  }),
  expiresIn: z.string().default('24h')
});

// JWT payload schema
export const JWTPayloadSchema = z.object({
  userId: z.string(),
  username: z.string(),
  role: RoleSchema,
  iat: z.number(),
  exp: z.number()
});
