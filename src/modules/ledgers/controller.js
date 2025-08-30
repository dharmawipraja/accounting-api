/**
 * Ledgers Controller
 * HTTP request handlers for ledger operations
 */

import { businessErrors, errors } from '../../core/errors/index.js';
import { HTTP_STATUS } from '../../shared/constants/index.js';
import {
  buildPaginationMeta,
  createPaginatedResponse,
  createSuccessResponse,
  extractId,
  extractPagination,
  resourceErrors
} from '../../shared/utils/index.js';
import { t } from '../../shared/i18n/index.js';

export class LedgersController {
  constructor(ledgersService) {
    this.ledgersService = ledgersService;
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

      const response = createSuccessResponse(result, t('ledgers.ledgerEntriesCreatedSuccessfully'));
      res.status(HTTP_STATUS.CREATED).json(response);
    } catch (error) {
      request.log.error({ error, ledgerData: request.body }, 'Failed to create bulk ledgers');

      if (error.message.includes('accounts not found')) {
        throw errors.validation(error.message);
      }

      throw resourceErrors.createFailed('Ledger entries');
    }
  }

  /**
   * Get all ledgers with pagination and filtering
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getLedgers(request, res) {
    try {
      const { page, limit, skip } = extractPagination(request);
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
      throw resourceErrors.listFailed('Ledger entries');
    }
  }

  /**
   * Get ledger by ID
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getLedgerById(request, res) {
    try {
      const id = extractId(request);

      const ledger = await this.ledgersService.getLedgerById(id);

      if (!ledger) {
        throw resourceErrors.notFound('Ledger entry');
      }

      const response = createSuccessResponse(ledger, t('ledgers.ledgerEntryRetrievedSuccessfully'));
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, ledgerId: request.params.id }, 'Failed to get ledger');
      throw resourceErrors.retrieveFailed('Ledger entry');
    }
  }

  /**
   * Update ledger
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async updateLedger(request, res) {
    try {
      const id = extractId(request);
      const updateData = request.body;
      const updatedBy = request.user.id;

      const updatedLedger = await this.ledgersService.updateLedger(id, updateData, updatedBy);

      const response = createSuccessResponse(
        updatedLedger,
        t('ledgers.ledgerEntryUpdatedSuccessfully')
      );
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
        throw resourceErrors.notFound('Ledger entry');
      }

      if (error.message === 'Cannot update posted ledger entries') {
        throw businessErrors.cannotUpdatePostedLedger();
      }

      throw resourceErrors.updateFailed('Ledger entry');
    }
  }

  /**
   * Delete ledger
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async deleteLedger(request, res) {
    try {
      const id = extractId(request);
      const deletedBy = request.user.id;

      const result = await this.ledgersService.deleteLedger(id, deletedBy);

      const response = createSuccessResponse(result, t('ledgers.ledgerEntryDeletedSuccessfully'));
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message === 'Ledger not found') {
        throw resourceErrors.notFound('Ledger entry');
      }

      if (error.message === 'Cannot delete posted ledger entries') {
        throw businessErrors.cannotUpdatePostedLedger();
      }

      request.log.error({ error, ledgerId: request.params.id }, 'Failed to delete ledger');
      throw resourceErrors.deleteFailed('Ledger entry');
    }
  }

  /**
   * Get ledgers by specific date
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getLedgersByDate(request, res) {
    try {
      const { ledgerDate } = request.params;

      const result = await this.ledgersService.getLedgersByDate(ledgerDate);

      const response = createSuccessResponse(result, t('ledgers.ledgersRetrievedSuccessfully'));
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message === 'No ledgers found for the specified date') {
        throw errors.validation(error.message);
      }

      if (error.message.includes('Invalid date format')) {
        throw errors.validation(error.message);
      }

      request.log.error(
        {
          error,
          ledgerDate: request.body.ledgerDate
        },
        'Failed to get ledgers by date'
      );
      throw resourceErrors.retrieveFailed('Ledgers by date');
    }
  }
}
