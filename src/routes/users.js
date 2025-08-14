/**
 * User Routes
 *
 * Routes with role-based access control as per ROUTES.md:
 * - Register: Admin and Manager can register user
 * - Get all users: Admin and Manager can get all users
 * - Get user: Admin and Manager can get user detail
 * - Edit user: Admin and Manager can edit user profile
 * - Delete user: Admin and Manager can delete user using soft delete
 * - Profile: Every user can see their own detail
 */

import { hashPassword, requireAdminOrManager, validate } from '../middleware/index.js';
import {
  IdParamSchema,
  UserCreateSchema,
  UserQuerySchema,
  UserUpdateSchema
} from '../schemas/index.js';
import { createSuccessResponse, getPaginationMeta } from '../utils/index.js';

export const userRoutes = async fastify => {
  // Register user - Admin and Manager only
  fastify.post(
    '/register',
    {
      preHandler: [fastify.authenticate, requireAdminOrManager],
      schema: {
        description: 'Register a new user (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['username', 'password', 'name'],
          properties: {
            username: {
              type: 'string',
              minLength: 3,
              maxLength: 50,
              pattern: '^[a-zA-Z0-9_]+$'
            },
            password: { type: 'string', minLength: 8, maxLength: 100 },
            name: { type: 'string', minLength: 2, maxLength: 100 },
            role: {
              type: 'string',
              enum: ['NASABAH', 'KASIR', 'KOLEKTOR', 'MANAJER', 'ADMIN', 'AKUNTAN'],
              default: 'NASABAH'
            },
            status: {
              type: 'string',
              enum: ['ACTIVE', 'INACTIVE'],
              default: 'ACTIVE'
            }
          }
        },
        response: {
          201: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  username: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  status: { type: 'string' },
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
      const validatedData = validate({ body: UserCreateSchema })(request);
      const { username, password, name, role = 'NASABAH', status = 'ACTIVE' } = validatedData.body;

      try {
        // Check if username already exists
        const existingUser = await fastify.prisma.user.findUnique({
          where: { username }
        });

        if (existingUser) {
          throw reply.conflict('Username already exists');
        }

        // Hash password
        const hashedPassword = await hashPassword(password);

        // Create user
        const newUser = await fastify.prisma.user.create({
          data: {
            username,
            password: hashedPassword,
            name,
            role,
            status,
            updatedAt: new Date()
          },
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

        const response = createSuccessResponse(newUser);
        reply.status(201).send(response);
      } catch (error) {
        if (error.statusCode) {
          throw error;
        }

        fastify.log.error({ error, username }, 'User registration error');
        throw reply.internalServerError('Failed to register user');
      }
    }
  );

  // Get all users with pagination and filtering - Admin and Manager only
  fastify.get(
    '/',
    {
      preHandler: [
        fastify.authenticate,
        requireAdminOrManager,
        validate({ query: UserQuerySchema })
      ],
      schema: {
        description: 'Get all users with pagination and filtering (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            search: { type: 'string' },
            role: {
              type: 'string',
              enum: ['NASABAH', 'KASIR', 'KOLEKTOR', 'MANAJER', 'ADMIN', 'AKUNTAN']
            },
            status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    username: { type: 'string' },
                    name: { type: 'string' },
                    role: { type: 'string' },
                    status: { type: 'string' },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' }
                  }
                }
              },
              meta: {
                type: 'object',
                properties: {
                  timestamp: { type: 'string' },
                  pagination: {
                    type: 'object',
                    properties: {
                      page: { type: 'integer' },
                      limit: { type: 'integer' },
                      total: { type: 'integer' },
                      totalPages: { type: 'integer' },
                      hasNext: { type: 'boolean' },
                      hasPrev: { type: 'boolean' },
                      nextPage: { type: ['integer', 'null'] },
                      prevPage: { type: ['integer', 'null'] }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    async (request, _reply) => {
      const { page, limit, search, role, status } = request.query;

      // Build where clause
      const where = {
        ...(search && {
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } }
          ]
        }),
        ...(role && { role }),
        ...(status && { status })
      };

      const skip = (page - 1) * limit;

      // Execute queries
      const [users, total] = await Promise.all([
        request.server.prisma.user.findMany({
          where,
          select: {
            id: true,
            username: true,
            name: true,
            role: true,
            status: true,
            createdAt: true,
            updatedAt: true
          },
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' }
        }),
        request.server.prisma.user.count({ where })
      ]);

      const paginationMeta = getPaginationMeta(page, limit, total);

      return createSuccessResponse(users, paginationMeta);
    }
  );

  // Get user by ID - Admin and Manager only
  fastify.get(
    '/:id',
    {
      preHandler: [
        fastify.authenticate,
        requireAdminOrManager,
        validate({ params: IdParamSchema })
      ],
      schema: {
        description: 'Get user by ID (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }
          },
          required: ['id']
        },
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
                  role: { type: 'string' },
                  status: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' }
                }
              },
              meta: {
                type: 'object',
                properties: {
                  timestamp: { type: 'string' }
                }
              }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const { id } = request.params;

      const user = await request.server.prisma.user.findUnique({
        where: { id },
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
        return reply.status(404).send({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found'
          }
        });
      }

      return createSuccessResponse(user);
    }
  );

  // Update user - Admin and Manager only
  fastify.put(
    '/:id',
    {
      preHandler: [
        fastify.authenticate,
        requireAdminOrManager,
        validate({
          params: IdParamSchema,
          body: UserUpdateSchema
        })
      ],
      schema: {
        description: 'Update user by ID (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }
          },
          required: ['id']
        },
        body: {
          type: 'object',
          properties: {
            password: { type: 'string', minLength: 8, maxLength: 100 },
            name: { type: 'string', minLength: 2, maxLength: 100 },
            role: {
              type: 'string',
              enum: ['NASABAH', 'KASIR', 'KOLEKTOR', 'MANAJER', 'ADMIN', 'AKUNTAN']
            },
            status: {
              type: 'string',
              enum: ['ACTIVE', 'INACTIVE']
            }
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
                  id: { type: 'string' },
                  username: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  status: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      const updateData = { ...request.body };

      try {
        // Hash password if provided
        if (updateData.password) {
          updateData.password = await hashPassword(updateData.password);
        }

        const updatedUser = await fastify.prisma.user.update({
          where: { id },
          data: {
            ...updateData,
            updatedAt: new Date()
          },
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

        const response = createSuccessResponse(updatedUser);
        reply.send(response);
      } catch (error) {
        if (error.statusCode) {
          throw error;
        }

        if (error.code === 'P2025') {
          throw reply.notFound('User not found');
        }

        fastify.log.error({ error, userId: id }, 'Update user error');
        throw reply.internalServerError('Failed to update user');
      }
    }
  );

  // Delete user (soft delete) - Admin and Manager only
  fastify.delete(
    '/:id',
    {
      preHandler: [
        fastify.authenticate,
        requireAdminOrManager,
        validate({ params: IdParamSchema })
      ],
      schema: {
        description: 'Delete user by ID using soft delete (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }
          },
          required: ['id']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  message: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const { id } = request.params;

      try {
        // Check if user exists and is not already deleted
        const existingUser = await fastify.prisma.user.findUnique({
          where: { id }
        });

        if (!existingUser) {
          throw reply.notFound('User not found');
        }

        // Note: The current Prisma schema doesn't have deletedAt field
        // This would need to be added to the User model for true soft delete
        // For now, we'll set status to INACTIVE as a soft delete alternative
        await fastify.prisma.user.update({
          where: { id },
          data: {
            status: 'INACTIVE',
            updatedAt: new Date()
          }
        });

        const response = createSuccessResponse({
          message: 'User deleted successfully (status set to INACTIVE)'
        });
        reply.send(response);
      } catch (error) {
        if (error.statusCode) {
          throw error;
        }

        if (error.code === 'P2025') {
          throw reply.notFound('User not found');
        }

        fastify.log.error({ error, userId: id }, 'Delete user error');
        throw reply.internalServerError('Failed to delete user');
      }
    }
  );

  // Profile route - Every user can see their own detail
  fastify.get(
    '/profile',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get current user profile (Every user can see their own detail)',
        tags: ['users'],
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
                  role: { type: 'string' },
                  status: { type: 'string' },
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
