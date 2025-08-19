/**
 * Express Application Factory
 * Creates and configures the Express application using best practices
 */

import express from 'express';
import config from '../config/index.js';
import container from '../core/container/index.js';
import logger, { createLogger } from '../core/logging/index.js';
import { setupErrorHandling } from './middleware/errorHandling.js';
import { applyMiddleware } from './middleware/index.js';
import { setupHealthChecks } from './routes/health.js';
import { registerRoutes } from './routes/index.js';

/**
 * Create and configure Express application
 * @returns {Promise<express.Application>} Configured Express app
 */
export async function createApp() {
  // Initialize dependency container
  await container.initialize();

  // Get configuration
  const appConfig = config.getConfig();
  config.validateConfig(appConfig);

  // Create Express application
  const app = express();

  // Create and attach logger
  const logger = createLogger(appConfig);
  app.locals.logger = logger;
  app.locals.container = container;

  // Apply middleware in correct order
  await applyMiddleware(app, appConfig);

  // Setup health checks (before other routes)
  setupHealthChecks(app);

  // Register application routes
  await registerRoutes(app);

  // Setup error handling (must be last)
  setupErrorHandling(app);

  return app;
}

/**
 * Graceful shutdown handler
 */
export async function gracefulShutdown(server) {
  logger.info('Received shutdown signal. Starting graceful shutdown...');

  // Stop accepting new connections
  server.close(async err => {
    if (err) {
      logger.error('Error during server shutdown:', err);
      process.exit(1);
    }

    try {
      // Cleanup dependencies
      await container.cleanup();
      logger.log('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during cleanup:', error);
      process.exit(1);
    }
  });

  // Force shutdown after timeout
  global.setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}
