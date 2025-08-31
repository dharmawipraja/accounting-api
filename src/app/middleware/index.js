/**
 * Middleware Index
 * Central middleware configuration for Express application
 */

import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import responseTime from 'response-time';
import { v4 as uuidv4 } from 'uuid';
import { t } from '../../shared/i18n/index.js';

/**
 * Apply all middleware to Express app in correct order
 * @param {express.Application} app - Express application
 * @param {Object} config - Application configuration
 */
export async function applyMiddleware(app, config) {
  // Trust proxy setting (first)
  if (config.server.trustProxy) {
    app.set('trust proxy', config.server.trustProxy);
  }

  // Request ID middleware (early)
  app.use(requestIdMiddleware);

  // HTTP request logging
  app.use(loggingMiddleware(app.locals.logger || console, config));

  // Response time tracking
  app.use(responseTimeMiddleware);

  // Security middleware
  app.use(securityMiddleware(config));

  // Body parsing middleware
  const bodyParsing = bodyParsingMiddleware(config);
  bodyParsing.forEach(middleware => app.use(middleware));

  // Rate limiting
  app.use(rateLimitMiddleware(config));

  // Compression (after body parsing)
  app.use(compressionMiddleware(config));

  // CORS configuration
  // app.use(corsMiddleware(config));
}

/**
 * Request ID middleware
 */
function requestIdMiddleware(req, res, next) {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
}

/**
 * Logging middleware
 */
function loggingMiddleware(logger, config) {
  return pinoHttp({
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
    ...(config.nodeEnv === 'production' && {
      redact: ['req.headers.authorization', 'req.headers.cookie']
    })
  });
}

/**
 * Response time middleware
 */
function responseTimeMiddleware(req, res, next) {
  return responseTime((req, res, time) => {
    res.setHeader('X-Response-Time', `${time.toFixed(2)}ms`);
  })(req, res, next);
}

/**
 * Security middleware
 */
function securityMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:']
      }
    },
    crossOriginEmbedderPolicy: false
  });
}

/**
 * Body parsing middleware
 */
function bodyParsingMiddleware(config) {
  return [
    express.json({
      limit: config.server.bodyLimit || '10mb'
    }),
    express.urlencoded({
      extended: true,
      limit: config.server.bodyLimit || '10mb'
    })
  ];
}

/**
 * Rate limiting middleware
 */
function rateLimitMiddleware(config) {
  return rateLimit({
    windowMs: config.security?.rateLimitWindow || 15 * 60 * 1000, // 15 minutes
    max: config.security?.rateLimitMax || 100, // limit each IP
    message: {
      success: false,
      error: 'Too Many Requests',
      message: t('rateLimit.tooManyRequests')
    },
    standardHeaders: true,
    legacyHeaders: false
  });
}

/**
 * Compression middleware
 */
function compressionMiddleware(config) {
  if (!config.features?.enableCompression) {
    return (req, res, next) => next();
  }

  return compression({
    threshold: config.features.compressionThreshold || 1024
  });
}

/**
 * CORS middleware
 */
function corsMiddleware(config) {
  // Default CORS configuration for development
  const defaultOrigins = ['http://localhost:3000', 'http://localhost:3001'];

  let corsOrigin;

  if (config.security?.corsOrigin) {
    // Use configured origins
    corsOrigin = Array.isArray(config.security.corsOrigin)
      ? config.security.corsOrigin
      : [config.security.corsOrigin];
  } else if (config.isDevelopment) {
    // Development default
    corsOrigin = defaultOrigins;
  } else {
    // Production default - be more restrictive
    corsOrigin = false;
  }

  return cors({
    origin: corsOrigin,
    credentials:
      config.security?.corsCredentials !== undefined ? config.security.corsCredentials : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'X-Request-ID'
    ],
    exposedHeaders: ['X-Request-ID', 'X-Response-Time'],
    optionsSuccessStatus: 200 // Support legacy browsers
  });
}
