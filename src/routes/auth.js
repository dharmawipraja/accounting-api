/**
 * Authentication Routes
 */

import { verifyPassword } from '../middleware/index.js';
import { zodToJsonSchema } from '../middleware/validation.js';
import {
  AuthResponseSchema,
  LoginSchema,
  SuccessResponseSchema,
  UserResponseSchema
} from '../schemas/index.js';
import { createSuccessResponse } from '../utils/index.js';

export const authRoutes = async fastify => {
  // Login route
  fastify.post(
    '/login',
    {
      // Keep authentication/other preHandlers here if needed
      schema: {
        description: 'User login with username and password',
        tags: ['auth'],
        // Use Zod schema for request body so fastify-type-provider-zod handles validation
        body: LoginSchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(AuthResponseSchema), {
            title: 'AuthLoginResponse'
          })
        }
      }
    },
    async (request, reply) => {
      const { username, password } = request.body;

      try {
        // Find user by username
        const user = await fastify.prisma.user.findFirst({
          where: {
            username,
            status: 'ACTIVE' // Only active users can login
          }
        });

        if (!user) {
          throw reply.unauthorized('Invalid username or password');
        }

        // Verify password
        const isValidPassword = await verifyPassword(password, user.password);
        if (!isValidPassword) {
          throw reply.unauthorized('Invalid username or password');
        }

        // Generate JWT token
        const token = fastify.jwt.sign(
          {
            id: user.id,
            username: user.username,
            role: user.role
          },
          {
            expiresIn: process.env.JWT_EXPIRES_IN || '24h'
          }
        );

        const response = createSuccessResponse({
          token,
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role
          },
          expiresIn: process.env.JWT_EXPIRES_IN || '24h'
        });

        reply.send(response);
      } catch (error) {
        if (error.statusCode) {
          throw error;
        }

        fastify.log.error({ error, username }, 'Login error');
        throw reply.internalServerError('Authentication failed');
      }
    }
  );

  // Get current user profile (protected route)
  fastify.get(
    '/me',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get current user profile',
        tags: ['auth'],
        security: [{ bearerAuth: [] }],
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(UserResponseSchema), {
            title: 'AuthMeResponse'
          })
        }
      }
    },
    async (request, reply) => {
      try {
        const userId = request.user.id;

        const user = await fastify.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            username: true,
            name: true,
            role: true,
            status: true,
            createdAt: true,
            updatedAt: true
          }
        });

        if (!user) {
          throw reply.notFound('User not found');
        }

        const response = createSuccessResponse(user);
        reply.send(response);
      } catch (error) {
        if (error.statusCode) {
          throw error;
        }

        fastify.log.error({ error, userId: request.user.id }, 'Get profile error');
        throw reply.internalServerError('Failed to fetch user profile');
      }
    }
  );
};
