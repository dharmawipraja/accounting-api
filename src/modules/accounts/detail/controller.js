/**
 * Account Detail Controller
 * HTTP request handlers for detailed account operations
 */

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
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async createAccount(request, reply) {
    try {
      const accountData = request.body;
      const createdBy = request.user.userId;

      const newAccount = await this.accountDetailService.createAccount(accountData, createdBy);

      const response = createSuccessResponse(newAccount, 'Account detail created successfully');
      reply.status(HTTP_STATUS.CREATED).send(response);
    } catch (error) {
      request.log.error({ error, accountData: request.body }, 'Failed to create account detail');

      if (error.message === 'Account number already exists') {
        throw reply.conflict(error.message);
      }

      if (error.message === 'General account not found') {
        throw reply.badRequest(error.message);
      }

      throw reply.internalServerError('Failed to create account detail');
    }
  }

  /**
   * Get all detail accounts with pagination and filtering
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getAccounts(request, reply) {
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

      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get account details');
      throw reply.internalServerError('Failed to retrieve account details');
    }
  }

  /**
   * Get detail account by ID
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getAccountById(request, reply) {
    try {
      const { id } = request.params;
      const { includeDeleted, includeLedgers } = request.query;

      const account = await this.accountDetailService.getAccountById(
        id,
        includeDeleted,
        includeLedgers
      );

      if (!account) {
        throw reply.notFound('Account detail not found');
      }

      const response = createSuccessResponse(account);
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, accountId: request.params.id }, 'Failed to get account detail');
      throw reply.internalServerError('Failed to retrieve account detail');
    }
  }

  /**
   * Update detail account
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async updateAccount(request, reply) {
    try {
      const { id } = request.params;
      const updateData = request.body;
      const updatedBy = request.user.userId;

      const updatedAccount = await this.accountDetailService.updateAccount(
        id,
        updateData,
        updatedBy
      );

      const response = createSuccessResponse(updatedAccount, 'Account detail updated successfully');
      reply.status(HTTP_STATUS.OK).send(response);
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
        throw reply.notFound(error.message);
      }

      throw reply.internalServerError('Failed to update account detail');
    }
  }

  /**
   * Soft delete detail account
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async deleteAccount(request, reply) {
    try {
      const { id } = request.params;
      const deletedBy = request.user.userId;

      const deletedAccount = await this.accountDetailService.deleteAccount(id, deletedBy);

      const response = createSuccessResponse(deletedAccount, 'Account detail deleted successfully');
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error({ error, accountId: request.params.id }, 'Failed to delete account detail');

      if (error.message === 'Account not found') {
        throw reply.notFound(error.message);
      }

      if (error.message === 'Cannot delete account with associated ledger entries') {
        throw reply.badRequest(error.message);
      }

      throw reply.internalServerError('Failed to delete account detail');
    }
  }
}
