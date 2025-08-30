/**
 * Users Controller
 * HTTP request handlers for user operations
 */

import { errors } from '../../core/errors/index.js';
import { HTTP_STATUS } from '../../shared/constants/index.js';
import {
  buildPaginationMeta,
  createPaginatedResponse,
  createSuccessResponse,
  extractId,
  extractPagination,
  resourceErrors
} from '../../shared/utils/index.js';
import { t } from '../../shared/i18n/index.js';

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

      const response = createSuccessResponse(newUser, t('users.userCreatedSuccessfully'));
      res.status(HTTP_STATUS.CREATED).json(response);
    } catch (error) {
      request.log.error({ error, userData: request.body }, 'Failed to create user');

      if (error.message === t('users.usernameAlreadyExists')) {
        throw errors.validation(error.message);
      }

      throw resourceErrors.createFailed('User');
    }
  }

  /**
   * Get all users with pagination and filtering
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getUsers(request, res) {
    try {
      const { page, limit, skip } = extractPagination(request);
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

      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get users');
      throw resourceErrors.listFailed('Users');
    }
  }

  /**
   * Get user by ID
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getUserById(request, res) {
    try {
      const id = extractId(request);

      const user = await this.usersService.getUserById(id);

      if (!user) {
        throw resourceErrors.notFound('User');
      }

      const response = createSuccessResponse(user);
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, userId: request.params.id }, 'Failed to get user');
      throw resourceErrors.retrieveFailed('User');
    }
  }

  /**
   * Update user
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async updateUser(request, res) {
    try {
      const id = extractId(request);
      const updateData = request.body;
      const updatedBy = request.user.id;

      const updatedUser = await this.usersService.updateUser(id, updateData, updatedBy);

      const response = createSuccessResponse(updatedUser, t('users.userUpdatedSuccessfully'));
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error(
        { error, userId: request.params.id, updateData: request.body },
        'Failed to update user'
      );

      if (error.message === t('users.usernameAlreadyExists')) {
        throw errors.validation(error.message);
      }

      if (error.code === 'P2025') {
        // Prisma record not found
        throw resourceErrors.notFound('User');
      }

      throw resourceErrors.updateFailed('User');
    }
  }

  /**
   * Soft delete user
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async deleteUser(request, res) {
    try {
      const id = extractId(request);
      const deletedBy = request.user.id;

      const deletedUser = await this.usersService.deleteUser(id, deletedBy);

      const response = createSuccessResponse(deletedUser, t('users.userDeletedSuccessfully'));
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message === t('users.userNotFound')) {
        throw resourceErrors.notFound('User');
      }

      request.log.error({ error, userId: request.params.id }, 'Failed to delete user');
      throw resourceErrors.deleteFailed('User');
    }
  }

  /**
   * Change user password
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async changePassword(request, res) {
    try {
      const id = extractId(request);
      const { currentPassword, newPassword } = request.body;

      const result = await this.usersService.changePassword(id, currentPassword, newPassword);

      const response = createSuccessResponse(result, t('users.passwordChangedSuccessfully'));

      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message === t('users.userNotFound')) {
        throw resourceErrors.notFound('User');
      }

      request.log.error({ error, userId: request.params.id }, 'Failed to delete user');
      throw resourceErrors.deleteFailed('User');
    }
  }
}
