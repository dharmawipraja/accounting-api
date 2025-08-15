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

import { z } from 'zod';
import { hashPassword, requireAdminOrManager } from '../middleware/index.js';
import { zodToJsonSchema } from '../middleware/validation.js';
import {
  ErrorResponseSchema,
  IdParamSchema,
  SuccessResponseSchema,
  UserCreateSchema,
  UserQuerySchema,
  UserResponseSchema,
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
        // Use Zod schema for request body validation
        body: UserCreateSchema,
        response: {
          201: zodToJsonSchema(SuccessResponseSchema(UserResponseSchema), {
            title: 'UserRegisterResponse'
          })
        }
      }
    },
    async (request, reply) => {
      const { username, password, name, role = 'NASABAH', status = 'ACTIVE' } = request.body;

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
      preHandler: [fastify.authenticate, requireAdminOrManager],
      schema: {
        description: 'Get all users with pagination and filtering (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        // Use Zod schema for querystring validation
        querystring: UserQuerySchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(z.array(UserResponseSchema)), {
            title: 'UserListResponse'
          })
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
      preHandler: [fastify.authenticate, requireAdminOrManager],
      schema: {
        description: 'Get user by ID (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        // Use Zod schema for params validation
        params: IdParamSchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(UserResponseSchema), {
            title: 'UserGetResponse'
          }),
          404: zodToJsonSchema(ErrorResponseSchema, { title: 'UserNotFoundResponse' })
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
      preHandler: [fastify.authenticate, requireAdminOrManager],
      schema: {
        description: 'Update user by ID (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        // Use Zod schemas for params and body validation
        params: IdParamSchema,
        body: UserUpdateSchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(UserResponseSchema), {
            title: 'UserUpdateResponse'
          })
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
      preHandler: [fastify.authenticate, requireAdminOrManager],
      schema: {
        description: 'Delete user by ID using soft delete (Admin and Manager only)',
        tags: ['users'],
        security: [{ bearerAuth: [] }],
        // Use Zod schema for params validation
        params: IdParamSchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(z.object({ message: z.string() })), {
            title: 'UserDeleteResponse'
          })
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
          200: zodToJsonSchema(SuccessResponseSchema(UserResponseSchema), {
            title: 'UserProfileResponse'
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
