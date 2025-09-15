/**
 * Express Ledger Routes
 * Ledger management endpoints using dependency injection
 */

import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { asyncHandler } from '../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

/**
 * Create ledger routes with dependency injection
 * @param {Object} container - Dependency injection container
 * @returns {Router} Express router
 */
export function createLedgerRoutes(container) {
  const router = Router();
  const ledgersController = container.get('ledgersController');

  // Apply authentication to all ledger routes
  router.use(authenticate);

  // Require accounting access for all routes
  router.use(requireAccountingAccess);

  // Get all ledgers
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
      query('startDate').optional().isISO8601().withMessage('Invalid start date format'),
      query('endDate').optional().isISO8601().withMessage('Invalid end date format')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await ledgersController.getLedgers(req, res);
    })
  );

  // Get ledger by ID
  router.get(
    '/:id',
    [commonValidations.id],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await ledgersController.getLedgerById(req, res);
    })
  );

  // Create bulk ledger entries
  router.post(
    '/',
    [
      body('ledgers').isArray({ min: 1 }).withMessage('Ledgers must be a non-empty array'),
      body('ledgers.*.description').trim().notEmpty().withMessage('Description is required'),
      body('ledgers.*.ledgerDate')
        .isISO8601()
        .withMessage('Ledger date must be a valid ISO 8601 date'),
      body('ledgers.*.ledgerType').notEmpty().isString().withMessage('Ledger type is required'),
      body('ledgers.*.amount')
        .isNumeric()
        .custom(value => {
          if (parseFloat(value) <= 0) {
            throw new Error('Amount must be greater than 0');
          }
          return true;
        }),
      body('ledgers.*.transactionType')
        .isIn(['DEBIT', 'KREDIT'])
        .withMessage('Transaction type must be DEBIT or KREDIT'),
      body('ledgers.*.accountDetailAccountNumber')
        .notEmpty()
        .isString()
        .withMessage('Account detail account number is required'),
      body('ledgers.*.accountGeneralAccountNumber')
        .notEmpty()
        .isString()
        .withMessage('Account general account number is required')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await ledgersController.createBulkLedgers(req, res);
    })
  );

  // Update ledger
  router.put(
    '/:id',
    [
      commonValidations.id,
      body('description').optional().trim().notEmpty().withMessage('Description cannot be empty'),
      body('amount')
        .optional()
        .isNumeric()
        .custom(value => {
          if (parseFloat(value) <= 0) {
            throw new Error('Amount must be greater than 0');
          }
          return true;
        }),
      body('transactionType')
        .optional()
        .isIn(['DEBIT', 'KREDIT'])
        .withMessage('Transaction type must be DEBIT or CREDIT')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await ledgersController.updateLedger(req, res);
    })
  );

  // Delete ledger
  router.delete(
    '/:id',
    [commonValidations.id],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await ledgersController.deleteLedger(req, res);
    })
  );

  // Get ledgers by date
  router.get(
    '/date/:ledgerDate',
    [
      param('ledgerDate')
        .trim()
        .notEmpty()
        .withMessage('Ledger date is required')
        .isISO8601()
        .withMessage('Invalid ledger date format')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await ledgersController.getLedgersByDate(req, res);
    })
  );

  return router;
}
