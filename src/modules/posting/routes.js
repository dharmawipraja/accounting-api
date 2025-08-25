/**
 * Express Posting Routes
 * Posting management endpoints using dependency injection
 */

import { Router } from 'express';
import { body } from 'express-validator';
import { asyncHandler } from '../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { validationMiddleware } from '../../core/security/security.js';

/**
 * Create posting routes with dependency injection
 * @param {Object} container - Dependency injection container
 * @returns {Router} Express router
 */
export function createPostingRoutes(container) {
  const router = Router();
  const postingController = container.get('postingController');

  // Apply authentication to all posting routes
  router.use(authenticate);

  // Require accounting access for all routes
  router.use(requireAccountingAccess);

  // Post ledgers by date
  router.post(
    '/ledger',
    [
      body('ledgerDate')
        .trim()
        .notEmpty()
        .withMessage('Ledger date is required')
        .isISO8601()
        .withMessage('Invalid ledger date format')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await postingController.postLedgersByDate(req, res);
    })
  );

  // Post balance by date - new endpoint
  router.post(
    '/balance',
    [
      body('date')
        .trim()
        .notEmpty()
        .withMessage('Date is required')
        .matches(/^\d{2}-\d{2}-\d{4}$/)
        .withMessage('Date must be in dd-mm-yyyy format')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await postingController.postBalanceByDate(req, res);
    })
  );

  // Unpost ledgers by date
  router.post(
    '/unposting/ledger',
    [
      body('ledgerDate')
        .trim()
        .notEmpty()
        .withMessage('Ledger date is required')
        .isISO8601()
        .withMessage('Invalid ledger date format')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await postingController.unpostLedgersByDate(req, res);
    })
  );

  // Unpost balance by date - new endpoint
  router.post(
    '/unposting/balance',
    [
      body('date')
        .trim()
        .notEmpty()
        .withMessage('Date is required')
        .matches(/^\d{2}-\d{2}-\d{4}$/)
        .withMessage('Date must be in dd-mm-yyyy format')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await postingController.unpostBalanceByDate(req, res);
    })
  );

  return router;
}
