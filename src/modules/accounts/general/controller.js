/**
 * Account General Controller
 * HTTP request handlers for general account operations
 */

import AppError from '../../../core/errors/AppError.js';
import ValidationError from '../../../core/errors/ValidationError.js';
import { buildPaginationMeta } from '../../../core/middleware/pagination.js';
import { HTTP_STATUS } from '../../../shared/constants/index.js';
import { createPaginatedResponse, createSuccessResponse } from '../../../shared/utils/response.js';
import { AccountGeneralService } from './service.js';

export class AccountGeneralController {
  constructor(prisma) {
    this.accountGeneralService = new AccountGeneralService(prisma);
  }

  /**
   * Create a new general account
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async createAccount(request, res) {
    try {
      const accountData = request.body;
      const createdBy = request.user.userId;

      const newAccount = await this.accountGeneralService.createAccount(accountData, createdBy);

      const response = createSuccessResponse(newAccount, 'Account general created successfully');
      res.status(HTTP_STATUS.CREATED).json(response);
    } catch (error) {
      request.log.error({ error, accountData: request.body }, 'Failed to create account general');

      if (error.message === 'Account number already exists') {
        throw res.conflict(error.message);
      }

      throw new AppError('Failed to create account general', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get all general accounts with pagination and filtering
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getAccounts(request, res) {
    try {
      const { page, limit, skip } = request.pagination;
      const { search, accountCategory, reportType, includeDeleted } = request.query;

      const { accounts, total } = await this.accountGeneralService.getAccounts({
        limit,
        skip,
        search,
        accountCategory,
        reportType,
        includeDeleted
      });

      const pagination = buildPaginationMeta(page, limit, total);
      const response = createPaginatedResponse(accounts, pagination);

      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get account generals');
      throw new AppError('Failed to retrieve account generals', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get general account by ID
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getAccountById(request, res) {
    try {
      const { id } = request.params;
      const { includeDeleted } = request.query;

      const account = await this.accountGeneralService.getAccountById(id, includeDeleted);

      if (!account) {
        throw new AppError('Account general not found', 404, 'NOT_FOUND');
      }

      const response = createSuccessResponse(account);
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, accountId: request.params.id }, 'Failed to get account general');
      throw new AppError('Failed to retrieve account general', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Update general account
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async updateAccount(request, res) {
    try {
      const { id } = request.params;
      const updateData = request.body;
      const updatedBy = request.user.userId;

      const updatedAccount = await this.accountGeneralService.updateAccount(
        id,
        updateData,
        updatedBy
      );

      const response = createSuccessResponse(
        updatedAccount,
        'Account general updated successfully'
      );
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error(
        {
          error,
          accountId: request.params.id,
          updateData: request.body
        },
        'Failed to update account general'
      );

      if (error.message === 'Account not found') {
        throw new AppError(error.message, 404, 'NOT_FOUND');
      }

      throw new AppError('Failed to update account general', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Soft delete general account
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async deleteAccount(request, res) {
    try {
      const { id } = request.params;
      const deletedBy = request.user.userId;

      const deletedAccount = await this.accountGeneralService.deleteAccount(id, deletedBy);

      const response = createSuccessResponse(
        deletedAccount,
        'Account general deleted successfully'
      );
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error(
        { error, accountId: request.params.id },
        'Failed to delete account general'
      );

      if (error.message === 'Account not found') {
        throw new AppError(error.message, 404, 'NOT_FOUND');
      }

      if (error.message === 'Cannot delete account with associated detail accounts') {
        throw new ValidationError(error.message);
      }

      throw new AppError('Failed to delete account general', 500, 'INTERNAL_ERROR');
    }
  }
}
