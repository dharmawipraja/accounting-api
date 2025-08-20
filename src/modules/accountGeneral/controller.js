/**
 * Account General Controller
 * HTTP request handlers for account general operations
 */

import {
  buildPaginationMeta,
  createPaginatedResponse,
  createSuccessResponse,
  extractAccountNumber,
  resourceErrors
} from '../../shared/utils/index.js';

export class AccountGeneralController {
  constructor(accountGeneralService) {
    this.accountGeneralService = accountGeneralService;
  }

  /**
   * Get all general accounts
   */
  async getAllAccounts(request, res) {
    try {
      const { page = 1, limit = 10, accountCategory, reportType, search } = request.query;

      const { accounts, total } = await this.accountGeneralService.getAllAccounts({
        page: parseInt(page),
        limit: parseInt(limit),
        accountCategory,
        reportType,
        search
      });

      const pagination = buildPaginationMeta(parseInt(page), parseInt(limit), total);
      const response = createPaginatedResponse(
        accounts,
        pagination,
        'General accounts retrieved successfully'
      );
      res.json(response);
    } catch (error) {
      request.log?.error({ error }, 'Failed to get general accounts');
      throw resourceErrors.listFailed('General accounts');
    }
  }

  /**
   * Get general account by account number
   */
  async getAccountByAccountNumber(request, res) {
    try {
      const accountNumber = extractAccountNumber(request);

      const account = await this.accountGeneralService.getAccountByAccountNumber(accountNumber);

      if (!account) {
        throw resourceErrors.notFound('General account');
      }

      res.json(createSuccessResponse(account, 'General account retrieved successfully'));
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log?.error(
        {
          error,
          accountNumber: request.params.accountNumber
        },
        'Failed to get general account'
      );
      throw resourceErrors.retrieveFailed('General account');
    }
  }

  /**
   * Create general account
   */
  async createAccount(request, res) {
    try {
      const accountData = request.body;

      const account = await this.accountGeneralService.createAccount(
        accountData,
        request.user.userId
      );

      res.status(201).json(createSuccessResponse(account, 'General account created successfully'));
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log?.error({ error, body: request.body }, 'Failed to create general account');
      throw resourceErrors.createFailed('General account');
    }
  }

  /**
   * Update general account
   */
  async updateAccount(request, res) {
    try {
      const accountNumber = extractAccountNumber(request);
      const updateData = request.body;

      const updatedAccount = await this.accountGeneralService.updateAccount(
        accountNumber,
        updateData,
        request.user.userId
      );

      res.json(createSuccessResponse(updatedAccount, 'General account updated successfully'));
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
        'Failed to update general account'
      );
      throw resourceErrors.updateFailed('General account');
    }
  }

  /**
   * Delete general account
   */
  async deleteAccount(request, res) {
    try {
      const accountNumber = extractAccountNumber(request);

      const deletedAccount = await this.accountGeneralService.deleteAccount(
        accountNumber,
        request.user.userId
      );

      res.json(createSuccessResponse(deletedAccount, 'General account deleted successfully'));
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log?.error(
        {
          error,
          accountNumber: request.params.accountNumber
        },
        'Failed to delete general account'
      );
      throw resourceErrors.deleteFailed('General account');
    }
  }
}
