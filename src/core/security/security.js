/**
 * Express Security Middleware Suite
 * Basic security middleware for Express.js
 */

import { body, param, query, validationResult } from 'express-validator';

// Request validation middleware
const validationMiddleware = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      message: 'Invalid input data',
      details: errors.array()
    });
  }
  next();
};

// Validation helpers for common patterns
export const commonValidations = {
  id: param('id').isString().withMessage('Invalid ID format'),
  username: body('username')
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be between 3 and 50 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  password: body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage(
      'Password must contain at least one lowercase letter, one uppercase letter, and one number'
    ),
  name: body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
  pagination: [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .toInt()
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 999999 })
      .toInt()
      .withMessage('Limit must be between 1 and 999999')
  ]
};

export { validationMiddleware };
