/**
 * Express Journal Ledger Routes
 * Journal ledger management endpoints using dependency injection
 */

import { Router } from 'express';
import { query } from 'express-validator';
import { asyncHandler } from '../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

/**
 * Create journal ledger routes with dependency injection
 * @param {Object} container - Dependency injection container
 * @returns {Router} Express router
 */
export function createJournalLedgerRoutes(container) {
  const router = Router();
  const journalLedgersController = container.get('journalLedgersController');

  // Apply authentication to all journal ledger routes
  router.use(authenticate);

  // Require accounting access for all routes
  router.use(requireAccountingAccess);

  // Get all journal ledgers
  router.get(
    '/',
    [
      ...commonValidations.pagination,
      query('accountDetailId')
        .optional()
        .isString()
        .withMessage('Invalid account detail ID format'),
      query('accountGeneralId')
        .optional()
        .isString()
        .withMessage('Invalid account general ID format'),
      query('postingStatus')
        .optional()
        .isIn(['PENDING', 'POSTED'])
        .withMessage('Posting status must be PENDING or POSTED'),
      query('startDate').optional().isISO8601().withMessage('Invalid start date format'),
      query('endDate').optional().isISO8601().withMessage('Invalid end date format'),
      query('includeAccounts')
        .optional()
        .isBoolean()
        .withMessage('Include accounts must be a boolean value')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await journalLedgersController.getJournalLedgers(req, res);
    })
  );

  // Get journal ledger by ID
  router.get(
    '/:id',
    [commonValidations.id],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await journalLedgersController.getJournalLedgerById(req, res);
    })
  );

  return router;
}
