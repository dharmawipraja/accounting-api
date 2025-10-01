/**
 * Journal Ledgers Controller
 * HTTP request handlers for journal ledger operations
 */

import { HTTP_STATUS } from '../../shared/constants/index.js';
import { t } from '../../shared/i18n/index.js';
import {
  buildPaginationMeta,
  createPaginatedResponse,
  createSuccessResponse,
  extractId,
  extractPagination,
  resourceErrors
} from '../../shared/utils/index.js';

export class JournalLedgersController {
  constructor(journalLedgersService) {
    this.journalLedgersService = journalLedgersService;
  }

  /**
   * Get all journal ledgers with pagination and filtering
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getJournalLedgers(request, res) {
    try {
      const { page, limit, skip } = extractPagination(request);
      const {
        search,
        postingStatus,
        accountDetailId,
        accountGeneralId,
        startDate,
        endDate,
        includeAccounts
      } = request.query;

      const { journalLedgers, total, totalDebit, totalCredit } =
        await this.journalLedgersService.getJournalLedgers({
          limit,
          skip,
          search,
          postingStatus,
          accountDetailId,
          accountGeneralId,
          startDate,
          endDate,
          includeAccounts
        });

      const pagination = buildPaginationMeta(page, limit, total);
      const response = createPaginatedResponse(
        { journalLedgers, totalDebit, totalCredit },
        pagination
      );

      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      request.log.error({ error, query: request.query }, 'Failed to get journal ledgers');
      throw resourceErrors.listFailed('Journal ledger entries');
    }
  }

  /**
   * Get journal ledger by ID
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getJournalLedgerById(request, res) {
    try {
      const id = extractId(request);

      const journalLedger = await this.journalLedgersService.getJournalLedgerById(id);

      if (!journalLedger) {
        throw resourceErrors.notFound('Journal ledger entry');
      }

      const response = createSuccessResponse(
        journalLedger,
        t('journalLedgers.journalLedgerEntryRetrievedSuccessfully')
      );
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error(
        { error, journalLedgerId: request.params.id },
        'Failed to get journal ledger'
      );
      throw resourceErrors.retrieveFailed('Journal ledger entry');
    }
  }
}
