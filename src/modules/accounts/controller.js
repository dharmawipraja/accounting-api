/**
 * Account Controller
 * HTTP request handlers for account operations
 */

import {
  buildPaginationMeta,
  createPaginatedResponse,
  createSuccessResponse,
  extractId,
  resourceErrors
} from '../../shared/utils/index.js';

export class AccountController {
  constructor(accountService) {
    this.accountService = accountService;
  }

  /**
   * Get general accounts
   */
  async getGeneralAccounts(request, res) {
    try {
      const { page = 1, limit = 10, accountCategory } = request.query;

      const { accounts, total } = await this.accountService.getGeneralAccounts({
        page: parseInt(page),
        limit: parseInt(limit),
        accountCategory
      });

      const pagination = buildPaginationMeta(parseInt(page), parseInt(limit), total);
      const response = createPaginatedResponse(
        accounts,
        pagination,
        'Accounts retrieved successfully'
      );
      res.json(response);
    } catch (error) {
      request.log?.error({ error }, 'Failed to get general accounts');
      throw resourceErrors.listFailed('General accounts');
    }
  }

  /**
   * Get general account by ID
   */
  async getGeneralAccountById(request, res) {
    try {
      const id = extractId(request);

      const account = await this.accountService.getGeneralAccountById(id);

      if (!account) {
        throw resourceErrors.notFound('Account');
      }

      res.json(createSuccessResponse(account, 'Account retrieved successfully'));
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log?.error({ error, accountId: request.params.id }, 'Failed to get general account');
      throw resourceErrors.retrieveFailed('Account');
    }
  }

  /**
   * Create general account
   */
  async createGeneralAccount(request, res) {
    try {
      const { accountNumber, accountName, accountCategory, reportType, transactionType } =
        request.body;

      const account = await this.accountService.createGeneralAccount(
        {
          accountNumber,
          accountName,
          accountCategory,
          reportType,
          transactionType
        },
        request.user.userId
      );

      res.status(201).json(createSuccessResponse(account, 'Account created successfully'));
    } catch (error) {
      request.log?.error({ error, body: request.body }, 'Failed to create general account');
      throw resourceErrors.createFailed('Account');
    }
  }

  /**
   * Get detail accounts
   */
  async getDetailAccounts(request, res) {
    try {
      const { page = 1, limit = 10, accountCategory, accountGeneralId } = request.query;

      const { accounts, total } = await this.accountService.getDetailAccounts({
        page: parseInt(page),
        limit: parseInt(limit),
        accountCategory,
        accountGeneralId
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
}
