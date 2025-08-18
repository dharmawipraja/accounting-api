import 'dotenv/config';
import { buildApp } from './src/app.js';
import env from './src/config/env.js';

const start = async () => {
  try {
    // Build the Express app
    const app = await buildApp();

    // Start the server
    const port = env.PORT || 3000;
    const host = env.HOST || '0.0.0.0';

    const server = app.listen(port, host, () => {
      console.log(`🚀 Express server running on http://${host}:${port}`);

      if (env.NODE_ENV === 'development') {
        console.log('🛠  Development mode enabled');
        console.log(`📚 API Documentation: http://${host}:${port}/docs`);
        console.log(`❤️  Health Check: http://${host}:${port}/health`);
      }
    });

    // Graceful shutdown handling
    const gracefulShutdown = signal => {
      console.log(`\n📴 Received ${signal}, shutting down gracefully...`);

      server.close(() => {
        console.log('✅ HTTP server closed');

        // Close database connections
        if (app.locals.prisma) {
          app.locals.prisma
            .$disconnect()
            .then(() => {
              console.log('✅ Database disconnected');
              process.exit(0);
            })
            .catch(err => {
              console.error('❌ Error disconnecting from database:', err);
              process.exit(1);
            });
        } else {
          process.exit(0);
        }
      });

      // Force shutdown after 10 seconds
      global.setTimeout(() => {
        console.error('❌ Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    // Handle different shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', err => {
      console.error('💥 Uncaught Exception:', err);
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  } catch (err) {
    console.error('❌ Server startup failed:', err);
    process.exit(1);
  }
};

start();
