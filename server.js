/**
 * Server Entry Point
 * Express server using modern patterns and dependency injection
 */

import 'dotenv/config';
import { createApp, gracefulShutdown } from './src/app/factory.js';
import config from './src/config/index.js';
import logger from './src/core/logging/index.js';

async function startServer() {
  try {
    // Create Express application
    const app = await createApp();

    // Get server configuration
    const { server } = config.getConfig();
    const { port } = server;
    const { host } = server;

    // Start the server
    const server_instance = app.listen(port, host, () => {
      logger.info(`🚀 Server running on http://${host}:${port}`);
      logger.info(`� Health check: http://${host}:${port}/health`);
      logger.info(`🔧 Readiness check: http://${host}:${port}/ready`);
      logger.info(`� API documentation: http://${host}:${port}/api`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    // Graceful shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown(server_instance));
    process.on('SIGINT', () => gracefulShutdown(server_instance));

    return server_instance;
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the server
startServer();
