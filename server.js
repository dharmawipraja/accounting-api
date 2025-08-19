import 'dotenv/config';
import { buildApp } from './src/app.js';
import env from './src/config/env.js';
import logger from './src/core/logging/index.js';

const start = async () => {
  try {
    // Build the Express app
    const app = await buildApp();

    // Start the server
    const port = env.PORT || 3000;
    const host = env.HOST || '0.0.0.0';

    const server = app.listen(port, host, () => {
      logger.info(`🚀 Express server running on http://${host}:${port}`);

      if (env.NODE_ENV === 'development') {
        logger.info('🛠  Development mode enabled');
        logger.info(`📚 API Documentation: http://${host}:${port}/docs`);
        logger.info(`❤️  Health Check: http://${host}:${port}/health`);
      }
    });

    // Graceful shutdown handling
    const gracefulShutdown = signal => {
      logger.info(`\n📴 Received ${signal}, shutting down gracefully...`);

      server.close(() => {
        logger.info('✅ HTTP server closed');

        // Close database connections
        if (app.locals.prisma) {
          app.locals.prisma
            .$disconnect()
            .then(() => {
              logger.info('✅ Database disconnected');
              process.exit(0);
            })
            .catch(err => {
              logger.error('❌ Error disconnecting from database:', err);
              process.exit(1);
            });
        } else {
          process.exit(0);
        }
      });

      // Force shutdown after 10 seconds
      global.setTimeout(() => {
        logger.error('❌ Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    // Handle different shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', err => {
      logger.fatal('💥 Uncaught Exception:', err);
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.fatal('💥 Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  } catch (err) {
    logger.fatal('❌ Server startup failed:', err);
    process.exit(1);
  }
};

start();
