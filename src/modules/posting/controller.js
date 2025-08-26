/**
 * Posting Controller
 * HTTP request handlers for posting operations
 */

import { businessErrors, errors } from '../../core/errors/index.js';
import { HTTP_STATUS } from '../../shared/constants/index.js';
import { createSuccessResponse, resourceErrors } from '../../shared/utils/index.js';

export class PostingController {
  constructor(postingService) {
    this.postingService = postingService;
  }

  /**
   * Post ledgers for a specific date
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async postLedgersByDate(request, res) {
    try {
      const { ledgerDate } = request.body;
      const postedBy = request.user.id;

      const result = await this.postingService.postLedgersByDate(ledgerDate, postedBy);

      const response = createSuccessResponse(result, 'Ledgers posted successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message === 'No pending ledgers found for the specified date') {
        throw businessErrors.noPendingLedgers();
      }

      if (error.message.includes('have already been posted')) {
        throw businessErrors.alreadyPosted();
      }

      request.log.error(
        {
          error,
          ledgerDate: request.body.ledgerDate
        },
        'Failed to post ledgers'
      );
      throw resourceErrors.updateFailed('Ledger posting');
    }
  }

  /**
   * Post balance for a specific date
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async postBalanceByDate(request, res) {
    try {
      const { date } = request.body;
      const postedBy = request.user.id;

      const result = await this.postingService.postBalanceByDate(date, postedBy);

      const response = createSuccessResponse(result, 'Balance posted successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message.includes('has already been posted')) {
        throw businessErrors.alreadyPosted();
      }

      if (error.message === 'No pending journal ledger entries found up to the specified date') {
        throw businessErrors.noPendingLedgers();
      }

      if (
        error.message.includes('Account Detail with number') &&
        error.message.includes('not found')
      ) {
        throw errors.validation(error.message);
      }

      request.log.error(
        {
          error,
          date: request.body.date
        },
        'Failed to post balance'
      );
      throw resourceErrors.updateFailed('Balance posting');
    }
  }

  /**
   * Unpost ledgers for a specific date
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async unpostLedgersByDate(request, res) {
    try {
      const { ledgerDate } = request.body;
      const unpostedBy = request.user.id;

      const result = await this.postingService.unpostLedgersByDate(ledgerDate, unpostedBy);

      const response = createSuccessResponse(result, 'Ledgers unposted successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message === 'No posted ledgers found for the specified date') {
        throw errors.validation(error.message);
      }

      if (
        error.message.includes('Cannot unpost ledgers for date') &&
        error.message.includes('journal entries for this date have already been posted')
      ) {
        throw businessErrors.operationNotAllowed(
          'Cannot unpost ledgers when journal entries are already posted. Please unpost the balance first.'
        );
      }

      request.log.error(
        {
          error,
          ledgerDate: request.body.ledgerDate
        },
        'Failed to unpost ledgers'
      );
      throw resourceErrors.updateFailed('Ledger unposting');
    }
  }

  /**
   * Unpost balance entries from a specific date to current date
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async unpostBalanceByDate(request, res) {
    try {
      const { date } = request.body;
      const unpostedBy = request.user.id;

      const result = await this.postingService.unpostBalanceByDate(date, unpostedBy);

      const response = createSuccessResponse(result, 'Balance unposted successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message.includes('No posted balance entries found')) {
        throw errors.validation(error.message);
      }

      request.log.error(
        {
          error,
          date: request.body.date
        },
        'Failed to unpost balance'
      );
      throw resourceErrors.updateFailed('Balance unposting');
    }
  }

  /**
   * Post neraca balance (SHU calculation) for a specific date
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async postNeracaBalance(request, res) {
    try {
      const { date } = request.body;
      const postedBy = request.user.id;

      const result = await this.postingService.postNeracaBalance(date, postedBy);

      const response = createSuccessResponse(result, 'Neraca balance (SHU) posted successfully');
      res.status(HTTP_STATUS.OK).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (error.message.includes('has been closed and cannot be modified')) {
        throw businessErrors.operationNotAllowed(error.message);
      }

      if (
        error.message.includes('Account Detail with number 3200') &&
        error.message.includes('not found')
      ) {
        throw errors.validation(error.message);
      }

      request.log.error(
        {
          error,
          date: request.body.date
        },
        'Failed to post neraca balance'
      );
      throw resourceErrors.updateFailed('Neraca balance posting');
    }
  }
}
