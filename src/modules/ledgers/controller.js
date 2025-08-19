/**
 * Ledgers Controller
 * HTTP request handlers for ledger operations
 */

import AppError from '../../core/errors/AppError.js';
import ValidationError from '../../core/errors/ValidationError.js';
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
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async createBulkLedgers(request, res) {
    try {
      const ledgerData = request.body;
      const createdBy = request.user.id;

      const result = await this.ledgersService.createBulkLedgers(ledgerData, createdBy);

      const response = createSuccessResponse(result, 'Ledger entries created successfully');
      res.status(HTTP_STATUS.CREATED).json(response);
    } catch (error) {
      request.log.error({ error, ledgerData: request.body }, 'Failed to create bulk ledgers');

      if (error.message.includes('accounts not found')) {
        throw new ValidationError(error.message);
      }

      throw new AppError('Failed to create ledger entries', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get all ledgers with pagination and filtering
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getLedgers(request, res) {
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

      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get ledgers');
      throw new AppError('Failed to retrieve ledger entries', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get ledger by ID
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getLedgerById(request, res) {
    try {
      const { id } = request.params;

      const ledger = await this.ledgersService.getLedgerById(id);

      if (!ledger) {
        throw new AppError('Ledger entry not found', 404, 'NOT_FOUND');
      }

      const response = createSuccessResponse(ledger);
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, ledgerId: request.params.id }, 'Failed to get ledger');
      throw new AppError('Failed to retrieve ledger entry', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Update ledger
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async updateLedger(request, res) {
    try {
      const { id } = request.params;
      const updateData = request.body;
      const updatedBy = request.user.id;

      const updatedLedger = await this.ledgersService.updateLedger(id, updateData, updatedBy);

      const response = createSuccessResponse(updatedLedger, 'Ledger entry updated successfully');
      res.status(HTTP_STATUS.OK).json(response);
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
        throw new AppError(error.message, 404, 'NOT_FOUND');
      }

      if (error.message === 'Cannot update posted ledger entries') {
        throw new ValidationError(error.message);
      }

      throw new AppError('Failed to update ledger entry', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Delete ledger
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async deleteLedger(request, res) {
    try {
      const { id } = request.params;
      const deletedBy = request.user.id;

      const result = await this.ledgersService.deleteLedger(id, deletedBy);

      const response = createSuccessResponse(result, 'Ledger entry deleted successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error({ error, ledgerId: request.params.id }, 'Failed to delete ledger');

      if (error.message === 'Ledger not found') {
        throw new AppError(error.message, 404, 'NOT_FOUND');
      }

      if (error.message === 'Cannot delete posted ledger entries') {
        throw new ValidationError(error.message);
      }

      throw new AppError('Failed to delete ledger entry', 500, 'INTERNAL_ERROR');
    }
  }
}
