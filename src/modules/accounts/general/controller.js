/**
 * Account General Controller
 * HTTP request handlers for general account operations
 */

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
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async createAccount(request, reply) {
    try {
      const accountData = request.body;
      const createdBy = request.user.userId;

      const newAccount = await this.accountGeneralService.createAccount(accountData, createdBy);

      const response = createSuccessResponse(newAccount, 'Account general created successfully');
      reply.status(HTTP_STATUS.CREATED).send(response);
    } catch (error) {
      request.log.error({ error, accountData: request.body }, 'Failed to create account general');

      if (error.message === 'Account number already exists') {
        throw reply.conflict(error.message);
      }

      throw reply.internalServerError('Failed to create account general');
    }
  }

  /**
   * Get all general accounts with pagination and filtering
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getAccounts(request, reply) {
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

      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get account generals');
      throw reply.internalServerError('Failed to retrieve account generals');
    }
  }

  /**
   * Get general account by ID
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getAccountById(request, reply) {
    try {
      const { id } = request.params;
      const { includeDeleted } = request.query;

      const account = await this.accountGeneralService.getAccountById(id, includeDeleted);

      if (!account) {
        throw reply.notFound('Account general not found');
      }

      const response = createSuccessResponse(account);
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, accountId: request.params.id }, 'Failed to get account general');
      throw reply.internalServerError('Failed to retrieve account general');
    }
  }

  /**
   * Update general account
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async updateAccount(request, reply) {
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
      reply.status(HTTP_STATUS.OK).send(response);
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
        throw reply.notFound(error.message);
      }

      throw reply.internalServerError('Failed to update account general');
    }
  }

  /**
   * Soft delete general account
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async deleteAccount(request, reply) {
    try {
      const { id } = request.params;
      const deletedBy = request.user.userId;

      const deletedAccount = await this.accountGeneralService.deleteAccount(id, deletedBy);

      const response = createSuccessResponse(
        deletedAccount,
        'Account general deleted successfully'
      );
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error(
        { error, accountId: request.params.id },
        'Failed to delete account general'
      );

      if (error.message === 'Account not found') {
        throw reply.notFound(error.message);
      }

      if (error.message === 'Cannot delete account with associated detail accounts') {
        throw reply.badRequest(error.message);
      }

      throw reply.internalServerError('Failed to delete account general');
    }
  }
}
