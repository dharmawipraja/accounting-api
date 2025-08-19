/**
 * Account Controller
 * HTTP request handlers for account operations
 */

import { createPaginatedResponse, createSuccessResponse } from '../../shared/utils/response.js';

export class AccountController {
  constructor(accountService) {
    this.accountService = accountService;
  }

  /**
   * Get general accounts
   */
  async getGeneralAccounts(req, res) {
    try {
      const { page = 1, limit = 10, accountCategory } = req.query;

      const { accounts, total } = await this.accountService.getGeneralAccounts({
        page: parseInt(page),
        limit: parseInt(limit),
        accountCategory
      });

      res.json(
        createPaginatedResponse(accounts, { page, limit, total }, 'Accounts retrieved successfully')
      );
    } catch (error) {
      req.log?.error({ error }, 'Failed to get general accounts');
      throw error;
    }
  }

  /**
   * Get general account by ID
   */
  async getGeneralAccountById(req, res) {
    try {
      const { id } = req.params;

      const account = await this.accountService.getGeneralAccountById(id);

      if (!account) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Account not found'
        });
      }

      res.json(createSuccessResponse(account, 'Account retrieved successfully'));
    } catch (error) {
      req.log?.error({ error, accountId: req.params.id }, 'Failed to get general account');
      throw error;
    }
  }

  /**
   * Create general account
   */
  async createGeneralAccount(req, res) {
    try {
      const { accountNumber, accountName, accountCategory, reportType, transactionType } = req.body;

      const account = await this.accountService.createGeneralAccount(
        {
          accountNumber,
          accountName,
          accountCategory,
          reportType,
          transactionType
        },
        req.user.userId
      );

      res.status(201).json(createSuccessResponse(account, 'Account created successfully'));
    } catch (error) {
      req.log?.error({ error, body: req.body }, 'Failed to create general account');
      throw error;
    }
  }

  /**
   * Get detail accounts
   */
  async getDetailAccounts(req, res) {
    try {
      const { page = 1, limit = 10, accountCategory, accountGeneralId } = req.query;

      const { accounts, total } = await this.accountService.getDetailAccounts({
        page: parseInt(page),
        limit: parseInt(limit),
        accountCategory,
        accountGeneralId
      });

      res.json(
        createPaginatedResponse(
          accounts,
          { page, limit, total },
          'Detail accounts retrieved successfully'
        )
      );
    } catch (error) {
      req.log?.error({ error }, 'Failed to get detail accounts');
      throw error;
    }
  }
}
