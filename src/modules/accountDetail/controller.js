/**
 * Account Detail Controller
 * HTTP request handlers for account detail operations
 */

import {
  buildPaginationMeta,
  createPaginatedResponse,
  createSuccessResponse,
  extractAccountNumber,
  resourceErrors
} from '../../shared/utils/index.js';

export class AccountDetailController {
  constructor(accountDetailService) {
    this.accountDetailService = accountDetailService;
  }

  /**
   * Get all detail accounts
   */
  async getAllAccounts(request, res) {
    try {
      const {
        page = 1,
        limit = 10,
        accountCategory,
        reportType,
        accountGeneralAccountNumber,
        search
      } = request.query;

      const { accounts, total } = await this.accountDetailService.getAllAccounts({
        page: parseInt(page),
        limit: parseInt(limit),
        accountCategory,
        reportType,
        accountGeneralAccountNumber,
        search
      });

      const pagination = buildPaginationMeta(parseInt(page), parseInt(limit), total);
      const response = createPaginatedResponse(
        accounts,
        pagination,
        'Detail accounts retrieved successfully'
      );
      res.json(response);
    } catch (error) {
      request.log?.error({ error }, 'Failed to get detail accounts');
      throw resourceErrors.listFailed('Detail accounts');
    }
  }

  /**
   * Get detail account by account number
   */
  async getAccountByAccountNumber(request, res) {
    try {
      const accountNumber = extractAccountNumber(request);

      const account = await this.accountDetailService.getAccountByAccountNumber(accountNumber);

      if (!account) {
        throw resourceErrors.notFound('Detail account');
      }

      res.json(createSuccessResponse(account, 'Detail account retrieved successfully'));
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log?.error(
        {
          error,
          accountNumber: request.params.accountNumber
        },
        'Failed to get detail account'
      );
      throw resourceErrors.retrieveFailed('Detail account');
    }
  }

  /**
   * Create detail account
   */
  async createAccount(request, res) {
    try {
      const accountData = request.body;

      const account = await this.accountDetailService.createAccount(
        accountData,
        request.user.userId
      );

      res.status(201).json(createSuccessResponse(account, 'Detail account created successfully'));
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log?.error({ error, body: request.body }, 'Failed to create detail account');
      throw resourceErrors.createFailed('Detail account');
    }
  }

  /**
   * Update detail account
   */
  async updateAccount(request, res) {
    try {
      const accountNumber = extractAccountNumber(request);
      const updateData = request.body;

      const updatedAccount = await this.accountDetailService.updateAccount(
        accountNumber,
        updateData,
        request.user.userId
      );

      res.json(createSuccessResponse(updatedAccount, 'Detail account updated successfully'));
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log?.error(
        {
          error,
          accountNumber: request.params.accountNumber,
          body: request.body
        },
        'Failed to update detail account'
      );
      throw resourceErrors.updateFailed('Detail account');
    }
  }

  /**
   * Delete detail account
   */
  async deleteAccount(request, res) {
    try {
      const accountNumber = extractAccountNumber(request);

      const deletedAccount = await this.accountDetailService.deleteAccount(
        accountNumber,
        request.user.userId
      );

      res.json(createSuccessResponse(deletedAccount, 'Detail account deleted successfully'));
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log?.error(
        {
          error,
          accountNumber: request.params.accountNumber
        },
        'Failed to delete detail account'
      );
      throw resourceErrors.deleteFailed('Detail account');
    }
  }
}
