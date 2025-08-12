/**
 * User Routes
 *
 * Example routes demonstrating Zod validation usage
 */

import { randomUUID } from 'crypto';
import { validate } from '../middleware/validation.js';
import {
  IdParamSchema,
  UserCreateSchema,
  UserQuerySchema,
  UserUpdateSchema
} from '../schemas/index.js';
import { createSuccessResponse, getPaginationMeta } from '../utils/index.js';

export const userRoutes = async fastify => {
  // Get all users with pagination and filtering
  fastify.get(
    '/',
    {
      preHandler: validate({ query: UserQuerySchema }),
      schema: {
        description: 'Get all users with pagination and filtering',
        tags: ['users'],
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

  // Get user by ID
  fastify.get(
    '/:id',
    {
      preHandler: validate({ params: IdParamSchema }),
      schema: {
        description: 'Get user by ID',
        tags: ['users'],
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

  // Create new user
  fastify.post(
    '/',
    {
      preHandler: validate({ body: UserCreateSchema }),
      schema: {
        description: 'Create a new user',
        tags: ['users'],
        body: {
          type: 'object',
          properties: {
            username: { type: 'string', minLength: 3, maxLength: 50 },
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
          },
          required: ['username', 'password', 'name']
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
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  details: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        field: { type: 'string' },
                        message: { type: 'string' },
                        code: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const userData = request.body;

      try {
        // Check if username already exists
        const existingUser = await request.server.prisma.user.findUnique({
          where: { username: userData.username }
        });

        if (existingUser) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'USERNAME_TAKEN',
              message: 'Username is already taken'
            }
          });
        }

        // Create user (in real app, hash the password first!)
        const newUser = await request.server.prisma.user.create({
          data: {
            id: randomUUID(),
            ...userData,
            createdAt: new Date(),
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

        return reply.status(201).send(createSuccessResponse(newUser));
      } catch (error) {
        request.log.error('Error creating user:', error);
        return reply.status(500).send({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to create user'
          }
        });
      }
    }
  );

  // Update user
  fastify.put(
    '/:id',
    {
      preHandler: validate({
        params: IdParamSchema,
        body: UserUpdateSchema
      }),
      schema: {
        description: 'Update user by ID',
        tags: ['users'],
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
      const updateData = request.body;

      try {
        const updatedUser = await request.server.prisma.user.update({
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

        return createSuccessResponse(updatedUser);
      } catch (error) {
        if (error.code === 'P2025') {
          return reply.status(404).send({
            success: false,
            error: {
              code: 'USER_NOT_FOUND',
              message: 'User not found'
            }
          });
        }

        request.log.error('Error updating user:', error);
        return reply.status(500).send({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to update user'
          }
        });
      }
    }
  );

  // Delete user
  fastify.delete(
    '/:id',
    {
      preHandler: validate({ params: IdParamSchema }),
      schema: {
        description: 'Delete user by ID',
        tags: ['users'],
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
        await request.server.prisma.user.delete({
          where: { id }
        });

        return createSuccessResponse({ message: 'User deleted successfully' });
      } catch (error) {
        if (error.code === 'P2025') {
          return reply.status(404).send({
            success: false,
            error: {
              code: 'USER_NOT_FOUND',
              message: 'User not found'
            }
          });
        }

        request.log.error('Error deleting user:', error);
        return reply.status(500).send({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to delete user'
          }
        });
      }
    }
  );
};
