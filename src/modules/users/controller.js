/**
 * Users Controller
 * HTTP request handlers for user operations
 */

/**
 * Users Controller
 * HTTP request handlers for user operations
 */

import AppError from '../../core/errors/AppError.js';
import ValidationError from '../../core/errors/ValidationError.js';
import { buildPaginationMeta } from '../../core/middleware/pagination.js';
import { HTTP_STATUS } from '../../shared/constants/index.js';
import { createPaginatedResponse, createSuccessResponse } from '../../shared/utils/response.js';
import { UsersService } from './service.js';

export class UsersController {
  constructor(prisma) {
    this.usersService = new UsersService(prisma);
  }

  /**
   * Create a new user
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async createUser(request, reply) {
    try {
      const userData = request.body;
      const createdBy = request.user.userId;

      const newUser = await this.usersService.createUser(userData, createdBy);

      const response = createSuccessResponse(newUser, 'User created successfully');
      reply.status(HTTP_STATUS.CREATED).send(response);
    } catch (error) {
      request.log.error({ error, userData: request.body }, 'Failed to create user');

      if (error.message === 'Username already exists') {
        throw reply.conflict(error.message);
      }

      throw new AppError('Failed to create user', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get all users with pagination and filtering
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getUsers(request, reply) {
    try {
      const { page, limit, skip } = request.pagination;
      const { search, role, status } = request.query;

      const { users, total } = await this.usersService.getUsers({
        limit,
        skip,
        search,
        role,
        status
      });

      const pagination = buildPaginationMeta(page, limit, total);
      const response = createPaginatedResponse(users, pagination);

      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get users');
      throw new AppError('Failed to retrieve users', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get user by ID
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getUserById(request, reply) {
    try {
      const { id } = request.params;

      const user = await this.usersService.getUserById(id);

      if (!user) {
        throw new AppError('User not found', 404, 'NOT_FOUND');
      }

      const response = createSuccessResponse(user);
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, userId: request.params.id }, 'Failed to get user');
      throw new AppError('Failed to retrieve user', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Update user
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async updateUser(request, reply) {
    try {
      const { id } = request.params;
      const updateData = request.body;
      const updatedBy = request.user.userId;

      const updatedUser = await this.usersService.updateUser(id, updateData, updatedBy);

      const response = createSuccessResponse(updatedUser, 'User updated successfully');
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error(
        { error, userId: request.params.id, updateData: request.body },
        'Failed to update user'
      );

      if (error.message === 'Username already exists') {
        throw reply.conflict(error.message);
      }

      if (error.code === 'P2025') {
        // Prisma record not found
        throw new AppError('User not found', 404, 'NOT_FOUND');
      }

      throw new AppError('Failed to update user', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Soft delete user
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async deleteUser(request, reply) {
    try {
      const { id } = request.params;
      const deletedBy = request.user.userId;

      const deletedUser = await this.usersService.deleteUser(id, deletedBy);

      const response = createSuccessResponse(deletedUser, 'User deleted successfully');
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error({ error, userId: request.params.id }, 'Failed to delete user');

      if (error.code === 'P2025') {
        // Prisma record not found
        throw new AppError('User not found', 404, 'NOT_FOUND');
      }

      throw new AppError('Failed to delete user', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Change user password
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async changePassword(request, reply) {
    try {
      const { userId } = request.user;
      const { currentPassword, newPassword } = request.body;

      await this.usersService.changePassword(userId, currentPassword, newPassword);

      const response = createSuccessResponse(
        { message: 'Password changed successfully' },
        'Password updated'
      );
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error({ error, userId: request.user?.userId }, 'Failed to change password');

      if (error.message === 'User not found') {
        throw new AppError(error.message, 404, 'NOT_FOUND');
      }

      if (error.message === 'Current password is incorrect') {
        throw new ValidationError(error.message);
      }

      throw new AppError('Failed to change password', 500, 'INTERNAL_ERROR');
    }
  }
}
