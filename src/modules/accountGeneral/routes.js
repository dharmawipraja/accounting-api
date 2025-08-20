/**
 * Express Account General Routes
 * Account general management endpoints using dependency injection
 */

import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { asyncHandler } from '../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

/**
 * Create account general routes with dependency injection
 * @param {Object} container - Dependency injection container
 * @returns {Router} Express router
 */
export function createAccountGeneralRoutes(container) {
  const router = Router();
  const accountGeneralController = container.get('accountGeneralController');

  // Apply authentication and authorization to all routes
  router.use(authenticate);
  router.use(requireAccountingAccess);

  // Get all general accounts
  router.get(
    '/',
    [
      ...commonValidations.pagination,
      query('accountCategory')
        .optional()
        .isIn(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'])
        .withMessage('Invalid account category'),
      query('reportType')
        .optional()
        .isIn(['NERACA', 'LABA_RUGI'])
        .withMessage('Invalid report type'),
      query('search')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Search term is too long')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountGeneralController.getAllAccounts(req, res);
    })
  );

  // Get general account by account number
  router.get(
    '/:accountNumber',
    [
      param('accountNumber')
        .trim()
        .notEmpty()
        .withMessage('Account number is required')
        .isLength({ max: 20 })
        .withMessage('Account number is too long')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountGeneralController.getAccountByAccountNumber(req, res);
    })
  );

  // Create general account
  router.post(
    '/',
    [
      body('accountNumber')
        .trim()
        .notEmpty()
        .withMessage('Account number is required')
        .isLength({ max: 20 })
        .withMessage('Account number is too long'),
      body('accountName')
        .trim()
        .notEmpty()
        .withMessage('Account name is required')
        .isLength({ max: 100 })
        .withMessage('Account name is too long'),
      body('accountCategory')
        .isIn(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'])
        .withMessage('Invalid account category'),
      body('reportType').isIn(['NERACA', 'LABA_RUGI']).withMessage('Invalid report type'),
      body('transactionType').isIn(['DEBIT', 'CREDIT']).withMessage('Invalid transaction type'),
      body('initialAmountCredit')
        .optional()
        .isNumeric()
        .withMessage('Initial amount (credit) must be a number'),
      body('initialAmountDebit')
        .optional()
        .isNumeric()
        .withMessage('Initial amount (debit) must be a number')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountGeneralController.createAccount(req, res);
    })
  );

  // Update general account
  router.put(
    '/:accountNumber',
    [
      param('accountNumber')
        .trim()
        .notEmpty()
        .withMessage('Account number is required')
        .isLength({ max: 20 })
        .withMessage('Account number is too long'),
      body('accountNumber')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('Account number cannot be empty')
        .isLength({ max: 20 })
        .withMessage('Account number is too long'),
      body('accountName')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('Account name cannot be empty')
        .isLength({ max: 100 })
        .withMessage('Account name is too long'),
      body('accountCategory')
        .optional()
        .isIn(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'])
        .withMessage('Invalid account category'),
      body('reportType')
        .optional()
        .isIn(['NERACA', 'LABA_RUGI'])
        .withMessage('Invalid report type'),
      body('transactionType')
        .optional()
        .isIn(['DEBIT', 'CREDIT'])
        .withMessage('Invalid transaction type'),
      body('initialAmountCredit')
        .optional()
        .isNumeric()
        .withMessage('Initial amount (credit) must be a number'),
      body('initialAmountDebit')
        .optional()
        .isNumeric()
        .withMessage('Initial amount (debit) must be a number')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountGeneralController.updateAccount(req, res);
    })
  );

  // Delete general account
  router.delete(
    '/:accountNumber',
    [
      param('accountNumber')
        .trim()
        .notEmpty()
        .withMessage('Account number is required')
        .isLength({ max: 20 })
        .withMessage('Account number is too long')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountGeneralController.deleteAccount(req, res);
    })
  );

  return router;
}
