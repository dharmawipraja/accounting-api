/**
 * Users Routes
 * Route definitions for user management
 */

import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { authenticate, authorize } from '../../core/middleware/auth.js';
import { cacheControl } from '../../core/middleware/caching.js';
import { parsePagination } from '../../core/middleware/pagination.js';
import { CACHE_DURATION, USER_ROLES } from '../../shared/constants/index.js';
import {
  IdParamSchema,
  PaginatedResponseSchema,
  SuccessResponseSchema
} from '../../shared/schemas/base.js';
import { UsersController } from './controller.js';
import {
  PasswordChangeSchema,
  UserCreateSchema,
  UserQuerySchema,
  UserResponseSchema,
  UserUpdateSchema
} from './schemas.js';

// Authorization middleware - only Admin and Manager can manage users
const requireUserManagement = authorize(USER_ROLES.ADMIN, USER_ROLES.MANAJER);

export async function userRoutes(fastify) {
  const usersController = new UsersController(prisma);

  // Create user - Admin and Manager only
  fastify.post(
    '/',
    {
      preHandler: [authenticate, requireUserManagement],
      schema: {
        description: 'Create a new user (Admin and Manager only)',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        body: UserCreateSchema,
        response: {
          201: SuccessResponseSchema(UserResponseSchema)
        }
      }
    },
    usersController.createUser.bind(usersController)
  );

  // Get all users - Admin and Manager only
  fastify.get(
    '/',
    {
      preHandler: [
        authenticate,
        requireUserManagement,
        parsePagination(),
        cacheControl(CACHE_DURATION.MEDIUM, 'private')
      ],
      schema: {
        description: 'Get all users with pagination and filtering (Admin and Manager only)',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        querystring: UserQuerySchema,
        response: {
          200: PaginatedResponseSchema(UserResponseSchema)
        }
      }
    },
    usersController.getUsers.bind(usersController)
  );

  // Get user by ID - Admin and Manager only
  fastify.get(
    '/:id',
    {
      preHandler: [
        authenticate,
        requireUserManagement,
        cacheControl(CACHE_DURATION.MEDIUM, 'private')
      ],
      schema: {
        description: 'Get user by ID (Admin and Manager only)',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        response: {
          200: SuccessResponseSchema(UserResponseSchema)
        }
      }
    },
    usersController.getUserById.bind(usersController)
  );

  // Update user - Admin and Manager only
  fastify.put(
    '/:id',
    {
      preHandler: [authenticate, requireUserManagement],
      schema: {
        description: 'Update user (Admin and Manager only)',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        body: UserUpdateSchema,
        response: {
          200: SuccessResponseSchema(UserResponseSchema)
        }
      }
    },
    usersController.updateUser.bind(usersController)
  );

  // Delete user (soft delete) - Admin and Manager only
  fastify.delete(
    '/:id',
    {
      preHandler: [authenticate, requireUserManagement],
      schema: {
        description: 'Delete user (soft delete) - Admin and Manager only',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        response: {
          200: SuccessResponseSchema(UserResponseSchema)
        }
      }
    },
    usersController.deleteUser.bind(usersController)
  );

  // Change password - Any authenticated user can change their own password
  fastify.post(
    '/change-password',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Change current user password',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        body: PasswordChangeSchema,
        response: {
          200: SuccessResponseSchema(
            z.object({
              message: z.string()
            })
          )
        }
      }
    },
    usersController.changePassword.bind(usersController)
  );
}
