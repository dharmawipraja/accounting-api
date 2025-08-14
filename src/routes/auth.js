/**
 * Authentication Routes
 */

import { validate, verifyPassword } from '../middleware/index.js';
import { LoginSchema } from '../schemas/index.js';
import { createSuccessResponse } from '../utils/index.js';

export const authRoutes = async fastify => {
  // Login route
  fastify.post(
    '/login',
    {
      preHandler: validate({ body: LoginSchema }),
      schema: {
        description: 'User login with username and password',
        tags: ['auth'],
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 3, maxLength: 50 },
            password: { type: 'string', minLength: 1 }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                  user: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      username: { type: 'string' },
                      name: { type: 'string' },
                      role: {
                        type: 'string',
                        enum: ['NASABAH', 'KASIR', 'KOLEKTOR', 'MANAJER', 'ADMIN', 'AKUNTAN']
                      }
                    }
                  },
                  expiresIn: { type: 'string' }
                }
              }
            }
          },
          401: {
            type: 'object',
            properties: {
              statusCode: { type: 'number' },
              error: { type: 'string' },
              message: { type: 'string' }
            }
          }
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
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  username: { type: 'string' },
                  name: { type: 'string' },
                  role: {
                    type: 'string',
                    enum: ['NASABAH', 'KASIR', 'KOLEKTOR', 'MANAJER', 'ADMIN', 'AKUNTAN']
                  },
                  status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' }
                }
              }
            }
          }
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
