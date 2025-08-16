/**
 * Users Controller
 * HTTP request handlers for user operations
 */

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

      throw reply.internalServerError('Failed to create user');
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
      throw reply.internalServerError('Failed to retrieve users');
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
        throw reply.notFound('User not found');
      }

      const response = createSuccessResponse(user);
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, userId: request.params.id }, 'Failed to get user');
      throw reply.internalServerError('Failed to retrieve user');
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
        throw reply.notFound('User not found');
      }

      throw reply.internalServerError('Failed to update user');
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
        throw reply.notFound('User not found');
      }

      throw reply.internalServerError('Failed to delete user');
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
        throw reply.notFound(error.message);
      }

      if (error.message === 'Current password is incorrect') {
        throw reply.badRequest(error.message);
      }

      throw reply.internalServerError('Failed to change password');
    }
  }
}
