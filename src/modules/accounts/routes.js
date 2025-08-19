/**
 * Express Account Routes
 * Account management endpoints using dependency injection
 */

import { Router } from 'express';
import { body, query } from 'express-validator';
import { asyncHandler } from '../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

/**
 * Create account routes with dependency injection
 * @param {Object} container - Dependency injection container
 * @returns {Router} Express router
 */
export function createAccountRoutes(container) {
  const router = Router();
  const accountController = container.get('accountController');

  // Apply authentication to all account routes
  router.use(authenticate);
  router.use(requireAccountingAccess);

  // Mount sub-routers
  router.use('/general', createGeneralAccountRoutes(accountController));
  router.use('/detail', createDetailAccountRoutes(accountController));

  return router;
}

/**
 * Create general account routes
 */
function createGeneralAccountRoutes(accountController) {
  const router = Router();

  // Get all general accounts
  router.get(
    '/',
    [
      ...commonValidations.pagination,
      query('accountCategory')
        .optional()
        .isIn(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'])
        .withMessage('Invalid account category')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountController.getGeneralAccounts(req, res);
    })
  );

  // Get general account by ID
  router.get(
    '/:id',
    [commonValidations.id],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountController.getGeneralAccountById(req, res);
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
      body('transactionType').isIn(['DEBIT', 'CREDIT']).withMessage('Invalid transaction type')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountController.createGeneralAccount(req, res);
    })
  );

  return router;
}

/**
 * Create detail account routes
 */
function createDetailAccountRoutes(accountController) {
  const router = Router();

  // Get all detail accounts
  router.get(
    '/',
    [
      ...commonValidations.pagination,
      query('accountCategory')
        .optional()
        .isIn(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'])
        .withMessage('Invalid account category'),
      query('accountGeneralId')
        .optional()
        .isString()
        .withMessage('Account general ID must be a string')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await accountController.getDetailAccounts(req, res);
    })
  );

  return router;
}
