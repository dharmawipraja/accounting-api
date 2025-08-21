/**
 * Error Handling Middleware Setup
 * Centralized error handling configuration
 */

import { errorHandler, notFoundHandler } from '../../core/errors/index.js';
import logger from '../../core/logging/index.js';

/**
 * Setup error handling middleware
 * @param {express.Application} app - Express application
 */
export function setupErrorHandling(app) {
  // 404 handler (before global error handler)
  app.use(notFoundHandler);

  // Global error handler (must be last)
  app.use(errorHandler);

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optionally exit the process
    // process.exit(1);
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', error => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
  });
}
