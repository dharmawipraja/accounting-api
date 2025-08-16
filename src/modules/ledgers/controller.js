/**
 * Ledgers Controller
 * HTTP request handlers for ledger operations
 */

import { buildPaginationMeta } from '../../core/middleware/pagination.js';
import { HTTP_STATUS } from '../../shared/constants/index.js';
import { createPaginatedResponse, createSuccessResponse } from '../../shared/utils/response.js';
import { LedgersService } from './service.js';

export class LedgersController {
  constructor(prisma) {
    this.ledgersService = new LedgersService(prisma);
  }

  /**
   * Create bulk ledger entries
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async createBulkLedgers(request, reply) {
    try {
      const ledgerData = request.body;
      const createdBy = request.user.userId;

      const result = await this.ledgersService.createBulkLedgers(ledgerData, createdBy);

      const response = createSuccessResponse(result, 'Ledger entries created successfully');
      reply.status(HTTP_STATUS.CREATED).send(response);
    } catch (error) {
      request.log.error({ error, ledgerData: request.body }, 'Failed to create bulk ledgers');

      if (error.message.includes('accounts not found')) {
        throw reply.badRequest(error.message);
      }

      throw reply.internalServerError('Failed to create ledger entries');
    }
  }

  /**
   * Get all ledgers with pagination and filtering
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getLedgers(request, reply) {
    try {
      const { page, limit, skip } = request.pagination;
      const {
        search,
        referenceNumber,
        ledgerType,
        transactionType,
        postingStatus,
        accountDetailId,
        accountGeneralId,
        startDate,
        endDate,
        includeAccounts
      } = request.query;

      const { ledgers, total } = await this.ledgersService.getLedgers({
        limit,
        skip,
        search,
        referenceNumber,
        ledgerType,
        transactionType,
        postingStatus,
        accountDetailId,
        accountGeneralId,
        startDate,
        endDate,
        includeAccounts
      });

      const pagination = buildPaginationMeta(page, limit, total);
      const response = createPaginatedResponse(ledgers, pagination);

      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get ledgers');
      throw reply.internalServerError('Failed to retrieve ledger entries');
    }
  }

  /**
   * Get ledger by ID
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getLedgerById(request, reply) {
    try {
      const { id } = request.params;

      const ledger = await this.ledgersService.getLedgerById(id);

      if (!ledger) {
        throw reply.notFound('Ledger entry not found');
      }

      const response = createSuccessResponse(ledger);
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, ledgerId: request.params.id }, 'Failed to get ledger');
      throw reply.internalServerError('Failed to retrieve ledger entry');
    }
  }

  /**
   * Update ledger
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async updateLedger(request, reply) {
    try {
      const { id } = request.params;
      const updateData = request.body;
      const updatedBy = request.user.userId;

      const updatedLedger = await this.ledgersService.updateLedger(id, updateData, updatedBy);

      const response = createSuccessResponse(updatedLedger, 'Ledger entry updated successfully');
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error(
        {
          error,
          ledgerId: request.params.id,
          updateData: request.body
        },
        'Failed to update ledger'
      );

      if (error.message === 'Ledger not found') {
        throw reply.notFound(error.message);
      }

      if (error.message === 'Cannot update posted ledger entries') {
        throw reply.badRequest(error.message);
      }

      throw reply.internalServerError('Failed to update ledger entry');
    }
  }

  /**
   * Delete ledger
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async deleteLedger(request, reply) {
    try {
      const { id } = request.params;
      const deletedBy = request.user.userId;

      const result = await this.ledgersService.deleteLedger(id, deletedBy);

      const response = createSuccessResponse(result, 'Ledger entry deleted successfully');
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error({ error, ledgerId: request.params.id }, 'Failed to delete ledger');

      if (error.message === 'Ledger not found') {
        throw reply.notFound(error.message);
      }

      if (error.message === 'Cannot delete posted ledger entries') {
        throw reply.badRequest(error.message);
      }

      throw reply.internalServerError('Failed to delete ledger entry');
    }
  }
}
