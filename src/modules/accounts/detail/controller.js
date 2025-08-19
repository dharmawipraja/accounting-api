/**
 * Account Detail Controller
 * HTTP request handlers for detailed account operations
 */

import AppError from '../../../core/errors/AppError.js';
import ValidationError from '../../../core/errors/ValidationError.js';
import { buildPaginationMeta } from '../../../core/middleware/pagination.js';
import { HTTP_STATUS } from '../../../shared/constants/index.js';
import { createPaginatedResponse, createSuccessResponse } from '../../../shared/utils/response.js';
import { AccountDetailService } from './service.js';

export class AccountDetailController {
  constructor(prisma) {
    this.accountDetailService = new AccountDetailService(prisma);
  }

  /**
   * Create a new detail account
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async createAccount(request, res) {
    try {
      const accountData = request.body;
      const createdBy = request.user.id;

      const newAccount = await this.accountDetailService.createAccount(accountData, createdBy);

      const response = createSuccessResponse(newAccount, 'Account detail created successfully');
      res.status(HTTP_STATUS.CREATED).json(response);
    } catch (error) {
      request.log.error({ error, accountData: request.body }, 'Failed to create account detail');

      if (error.message === 'Account number already exists') {
        throw new ValidationError(error.message);
      }

      if (error.message === 'General account not found') {
        throw new ValidationError(error.message);
      }

      throw new AppError('Failed to create account detail', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get all detail accounts with pagination and filtering
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getAccounts(request, res) {
    try {
      const { page, limit, skip } = request.pagination;
      const {
        search,
        accountCategory,
        reportType,
        transactionType,
        accountGeneralId,
        includeDeleted,
        includeLedgers
      } = request.query;

      const { accounts, total } = await this.accountDetailService.getAccounts({
        limit,
        skip,
        search,
        accountCategory,
        reportType,
        transactionType,
        accountGeneralId,
        includeDeleted,
        includeLedgers
      });

      const pagination = buildPaginationMeta(page, limit, total);
      const response = createPaginatedResponse(accounts, pagination);

      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get account details');
      throw new AppError('Failed to retrieve account details', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get detail account by ID
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getAccountById(request, res) {
    try {
      const { id } = request.params;
      const { includeDeleted, includeLedgers } = request.query;

      const account = await this.accountDetailService.getAccountById(
        id,
        includeDeleted,
        includeLedgers
      );

      if (!account) {
        throw new AppError('Account detail not found', 404, 'NOT_FOUND');
      }

      const response = createSuccessResponse(account);
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, accountId: request.params.id }, 'Failed to get account detail');
      throw new AppError('Failed to retrieve account detail', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Update detail account
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async updateAccount(request, res) {
    try {
      const { id } = request.params;
      const updateData = request.body;
      const updatedBy = request.user.id;

      const updatedAccount = await this.accountDetailService.updateAccount(
        id,
        updateData,
        updatedBy
      );

      const response = createSuccessResponse(updatedAccount, 'Account detail updated successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error(
        {
          error,
          accountId: request.params.id,
          updateData: request.body
        },
        'Failed to update account detail'
      );

      if (error.message === 'Account not found') {
        throw new AppError(error.message, 404, 'NOT_FOUND');
      }

      throw new AppError('Failed to update account detail', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Soft delete detail account
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async deleteAccount(request, res) {
    try {
      const { id } = request.params;
      const deletedBy = request.user.id;

      const deletedAccount = await this.accountDetailService.deleteAccount(id, deletedBy);

      const response = createSuccessResponse(deletedAccount, 'Account detail deleted successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error({ error, accountId: request.params.id }, 'Failed to delete account detail');

      if (error.message === 'Account not found') {
        throw new AppError(error.message, 404, 'NOT_FOUND');
      }

      if (error.message === 'Cannot delete account with associated ledger entries') {
        throw new ValidationError(error.message);
      }

      throw new AppError('Failed to delete account detail', 500, 'INTERNAL_ERROR');
    }
  }
}
