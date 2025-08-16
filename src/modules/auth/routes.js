/**
 * Auth Routes
 * Route definitions for authentication endpoints
 */

import { z } from 'zod';
import { authenticate } from '../../core/middleware/auth.js';
import { ErrorResponseSchema, SuccessResponseSchema } from '../../shared/schemas/base.js';
import { AuthController } from './controller.js';
import { AuthResponseSchema, LoginSchema } from './schemas.js';

export const createAuthRoutes = jwtSecret => {
  return async function authRoutes(fastify) {
    const authController = new AuthController(fastify.prisma, jwtSecret);

    // Login endpoint
    fastify.post(
      '/login',
      {
        schema: {
          description: 'User login with username and password',
          tags: ['Authentication'],
          body: LoginSchema,
          response: {
            200: SuccessResponseSchema(AuthResponseSchema),
            401: ErrorResponseSchema,
            500: ErrorResponseSchema
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
            ),
            401: ErrorResponseSchema
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
            ),
            401: ErrorResponseSchema,
            404: ErrorResponseSchema
          }
        }
      },
      authController.getProfile.bind(authController)
    );
  };
};
