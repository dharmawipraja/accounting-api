/**
 * Auth Routes
 * Route definitions for authentication endpoints
 */

import { z } from 'zod';
import { authenticate } from '../../core/middleware/auth.js';
import { authRateLimitPlugin } from '../../core/security/rateLimiting.js';
import { SuccessResponseSchema } from '../../shared/schemas/base.js';
import { AuthController } from './controller.js';
import { AuthResponseSchema, LoginSchema } from './schemas.js';

export const createAuthRoutes = jwtSecret => {
  return async function authRoutes(fastify) {
    const authController = new AuthController(fastify.prisma, jwtSecret);

    // Register auth-specific rate limiting
    await fastify.register(authRateLimitPlugin);

    // Login endpoint
    fastify.post(
      '/login',
      {
        schema: {
          description: 'User login with username and password',
          tags: ['Authentication'],
          body: LoginSchema,
          response: {
            200: SuccessResponseSchema(AuthResponseSchema)
            // Removed error response schemas to prevent serialization conflicts
          }
        }
      },
      authController.login.bind(authController)
    );

    // Logout endpoint
    fastify.post(
      '/logout',
      {
        preHandler: [authenticate],
        schema: {
          description: 'User logout (client-side token removal)',
          tags: ['Authentication'],
          security: [{ bearerAuth: [] }],
          response: {
            200: SuccessResponseSchema(
              z.object({
                message: z.string()
              })
            )
          }
        }
      },
      authController.logout.bind(authController)
    );

    // Get current user profile
    fastify.get(
      '/profile',
      {
        preHandler: [authenticate],
        schema: {
          description: 'Get current user profile',
          tags: ['Authentication'],
          security: [{ bearerAuth: [] }],
          response: {
            200: SuccessResponseSchema(
              z.object({
                id: z.string(),
                username: z.string(),
                name: z.string(),
                role: z.string(),
                status: z.string(),
                createdAt: z.date(),
                updatedAt: z.date()
              })
            )
          }
        }
      },
      authController.getProfile.bind(authController)
    );
  };
};
