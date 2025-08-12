import 'dotenv/config';
import { build } from './src/app.js';

const start = async () => {
  let app;

  try {
    // Build the Fastify app with production-optimized logger
    app = await build({
      logger: {
        level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'warn' : 'info'),
        ...(process.env.NODE_ENV === 'development' && {
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
              colorize: true
            }
          }
        }),
        ...(process.env.NODE_ENV === 'production' && {
          // Production logging configuration
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          serializers: {
            req: req => ({
              method: req.method,
              url: req.url,
              hostname: req.hostname,
              remoteAddress: req.ip
            }),
            res: res => ({
              statusCode: res.statusCode
            })
          }
        })
      }
    });

    // Start the server
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({
      port,
      host,
      // Production optimizations
      ...(process.env.NODE_ENV === 'production' && {
        listenTextResolver: address => `Server listening at ${address}`
      })
    });

    app.log.info(`🚀 Server running on http://${host}:${port}`);

    if (process.env.NODE_ENV === 'development') {
      app.log.info('🛠  Development mode enabled');
    }
  } catch (err) {
    if (app) {
      app.log.error(err, 'Server startup failed');
    } else {
      console.error('Server startup failed:', err);
    }
    process.exit(1);
  }
};

// Graceful shutdown handling
const gracefulShutdown = signal => {
  console.log(`\n📴 Received ${signal}, shutting down gracefully...`);
  process.exit(0);
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

start();
