/**
 * Users Controller
 * HTTP request handlers for user operations
 */

import AppError from '../../core/errors/AppError.js';
import ValidationError from '../../core/errors/ValidationError.js';
import { HTTP_STATUS } from '../../shared/constants/index.js';
import {
  calculatePagination,
  createPaginatedResponse,
  createSuccessResponse
} from '../../shared/utils/response.js';

export class UsersController {
  constructor(usersService) {
    this.usersService = usersService;
  }

  /**
   * Create a new user
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async createUser(request, res) {
    try {
      const userData = request.body;
      const createdBy = request.user.id;

      const newUser = await this.usersService.createUser(userData, createdBy);

      const response = createSuccessResponse(newUser, 'User created successfully');
      res.status(HTTP_STATUS.CREATED).json(response);
    } catch (error) {
      request.log.error({ error, userData: request.body }, 'Failed to create user');

      if (error.message === 'Username already exists') {
        throw new ValidationError(error.message);
      }

      throw new AppError('Failed to create user', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get all users with pagination and filtering
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getUsers(request, res) {
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

      const pagination = calculatePagination(page, limit, total);
      const response = createPaginatedResponse(users, pagination);

      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get users');
      throw new AppError('Failed to retrieve users', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get user by ID
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getUserById(request, res) {
    try {
      const { id } = request.params;

      const user = await this.usersService.getUserById(id);

      if (!user) {
        throw new AppError('User not found', 404, 'NOT_FOUND');
      }

      const response = createSuccessResponse(user);
      res.status(HTTP_STATUS.OK).json(response);
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
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async updateUser(request, res) {
    try {
      const { id } = request.params;
      const updateData = request.body;
      const updatedBy = request.user.id;

      const updatedUser = await this.usersService.updateUser(id, updateData, updatedBy);

      const response = createSuccessResponse(updatedUser, 'User updated successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error(
        { error, userId: request.params.id, updateData: request.body },
        'Failed to update user'
      );

      if (error.message === 'Username already exists') {
        throw new ValidationError(error.message);
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
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async deleteUser(request, res) {
    try {
      const { id } = request.params;
      const deletedBy = request.user.id;

      const deletedUser = await this.usersService.deleteUser(id, deletedBy);

      const response = createSuccessResponse(deletedUser, 'User deleted successfully');
      res.status(HTTP_STATUS.OK).json(response);
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
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async changePassword(request, res) {
    try {
      const { userId } = request.user;
      const { currentPassword, newPassword } = request.body;

      await this.usersService.changePassword(userId, currentPassword, newPassword);

      const response = createSuccessResponse(
        { message: 'Password changed successfully' },
        'Password updated'
      );
      res.status(HTTP_STATUS.OK).json(response);
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
