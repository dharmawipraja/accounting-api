/**
 * Express Account Detail Routes
 * Account detail management endpoints using dependency injection
 */

import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { asyncHandler } from '../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

/**
 * Create account detail routes with dependency injection
 * @param {Object} container - Dependency injection container
 * @returns {Router} Express router
 */
export function createAccountDetailRoutes(container) {
  const router = Router();
  const accountDetailController = container.get('accountDetailController');

  // Apply authentication and authorization to all routes
  router.use(authenticate);
  router.use(requireAccountingAccess);

  // Get all detail accounts
  router.get(
    '/',
    [
      ...commonValidations.pagination,
      query('accountCategory')
        .optional()
        .isIn(['AKTIVA', 'PASIVA', 'PENJUALAN', 'BEBAN_DAN_BIAYA'])
        .withMessage('Invalid account category'),
      query('reportType')
        .optional()
        .isIn(['NERACA', 'LABA_RUGI'])
        .withMessage('Invalid report type'),
      query('accountGeneralAccountNumber')
        .optional()
        .trim()
        .isLength({ max: 20 })
        .withMessage('Account general account number is too long'),
      query('search')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Search term is too long')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountDetailController.getAllAccounts(req, res);
    })
  );

  // Get detail account by account number
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
      await accountDetailController.getAccountByAccountNumber(req, res);
    })
  );

  // Create detail account
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
      body('accountGeneralAccountNumber')
        .trim()
        .notEmpty()
        .withMessage('Account general account number is required')
        .isLength({ max: 20 })
        .withMessage('Account general account number is too long'),
      body('accountCategory')
        .isIn(['AKTIVA', 'PASIVA', 'PENJUALAN', 'BEBAN_DAN_BIAYA'])
        .withMessage('Invalid account category'),
      body('reportType').isIn(['NERACA', 'LABA_RUGI']).withMessage('Invalid report type'),
      body('transactionType').isIn(['DEBIT', 'KREDIT']).withMessage('Invalid transaction type'),
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
      await accountDetailController.createAccount(req, res);
    })
  );

  // Update detail account
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
      body('accountGeneralAccountNumber')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('Account general account number cannot be empty')
        .isLength({ max: 20 })
        .withMessage('Account general account number is too long'),
      body('accountCategory')
        .optional()
        .isIn(['AKTIVA', 'PASIVA', 'PENJUALAN', 'BEBAN_DAN_BIAYA'])
        .withMessage('Invalid account category'),
      body('reportType')
        .optional()
        .isIn(['NERACA', 'LABA_RUGI'])
        .withMessage('Invalid report type'),
      body('transactionType')
        .optional()
        .isIn(['DEBIT', 'KREDIT'])
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
      await accountDetailController.updateAccount(req, res);
    })
  );

  // Delete detail account
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
      await accountDetailController.deleteAccount(req, res);
    })
  );

  return router;
}
