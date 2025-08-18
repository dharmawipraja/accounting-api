import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import responseTime from 'response-time';
import { v4 as uuidv4 } from 'uuid';

import { databaseMiddleware } from './config/database.js';
import config from './config/index.js';
import { globalErrorHandler, notFoundHandler } from './core/errors/index.js';
import { createLogger } from './core/logging/index.js';
import { registerRoutes } from './router.js';

export async function buildApp() {
  // Get application configuration
  const appConfig = config.getConfig();

  // Validate configuration
  config.validateConfig(appConfig);

  const app = express();

  // Create logger
  const logger = createLogger(appConfig);

  // Trust proxy setting
  if (appConfig.server.trustProxy) {
    app.set('trust proxy', appConfig.server.trustProxy);
  }

  // Request ID middleware
  app.use((req, res, next) => {
    req.id = uuidv4();
    res.setHeader('X-Request-ID', req.id);
    next();
  });

  // HTTP request logging
  app.use(
    pinoHttp({
      logger,
      genReqId: req => req.id,
      serializers: {
        req: req => ({
          id: req.id,
          method: req.method,
          url: req.url,
          hostname: req.hostname,
          remoteAddress: req.ip,
          userAgent: req.headers && req.headers['user-agent']
        }),
        res: res => ({
          statusCode: res.statusCode
        })
      },
      ...(appConfig.nodeEnv === 'production' && {
        redact: ['req.headers.authorization', 'req.headers.cookie']
      })
    })
  );

  // Response time middleware
  app.use(
    responseTime((req, res, time) => {
      res.setHeader('X-Response-Time', `${time.toFixed(2)}ms`);
    })
  );

  // Body parsing middleware
  app.use(
    express.json({
      limit: appConfig.server.bodyLimit
    })
  );
  app.use(
    express.urlencoded({
      extended: true,
      limit: appConfig.server.bodyLimit
    })
  );

  // Simple rate limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
  });
  app.use(limiter);

  // Simple helmet security headers
  app.use(helmet());

  // Simple CORS
  app.use(cors());

  // Compression
  if (appConfig.features.enableCompression) {
    app.use(
      compression({
        threshold: appConfig.features.compressionThreshold
      })
    );
  }

  // Database middleware
  await databaseMiddleware(app);

  // Health check endpoint (before other routes)
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: appConfig.nodeEnv
    });
  });

  app.get('/ready', async (req, res) => {
    try {
      // Check database connectivity
      if (req.app.locals.prisma) {
        await req.app.locals.prisma.$queryRaw`SELECT 1`;
      }

      res.json({
        status: 'ready',
        timestamp: new Date().toISOString(),
        services: {
          database: 'connected'
        }
      });
    } catch (error) {
      res.status(503).json({
        status: 'not ready',
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  });

  // Register application routes
  await registerRoutes(app);

  // Error handling middleware (must be last)
  app.use(notFoundHandler);
  app.use(globalErrorHandler);

  return app;
}
