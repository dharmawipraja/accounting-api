/** Database configuration and Prisma client setup */

import { PrismaClient } from '@prisma/client';
import { createSoftDeleteExtension } from 'prisma-extension-soft-delete';
import { env, isDevelopment, isTest } from './env.js';

/**
 * Database connection utilities for Express.js
 */

/**
 * Database configuration options based on environment
 */
const getDatabaseConfig = () => {
  const baseConfig = {
    // Datasource configuration
    datasources: {
      db: {
        url: env.DATABASE_URL
      }
    },

    // Transaction options
    transactionOptions: {
      maxWait: 5000, // 5 seconds
      timeout: 10000 // 10 seconds
    }
  };

  // Environment-specific configurations
  if (isDevelopment()) {
    return {
      ...baseConfig,
      log: [
        { level: 'query', emit: 'event' },
        { level: 'info', emit: 'stdout' },
        { level: 'warn', emit: 'stdout' },
        { level: 'error', emit: 'stdout' }
      ],
      errorFormat: 'colorless'
    };
  }

  if (isTest()) {
    return {
      ...baseConfig,
      log: [{ level: 'error', emit: 'stdout' }],
      errorFormat: 'minimal'
    };
  }

  // Production configuration
  return {
    ...baseConfig,
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' }
    ],
    errorFormat: 'minimal'
  };
};

/**
 * Create and configure Prisma client with enhanced error handling
 */
const createPrismaClient = () => {
  const config = getDatabaseConfig();
  const prisma = new PrismaClient(config);
  // soft-delete extension for models with 'deletedAt' field
  const softDeleteExt = createSoftDeleteExtension({
    models: { AccountDetail: true, AccountGeneral: true, Ledger: true },
    defaultConfig: { field: 'deletedAt', createValue: deleted => (deleted ? new Date() : null) }
  });
  const client = prisma.$extends(softDeleteExt);
  // helper to run a callback against the raw client (explicit opt-out)
  client.withSoftDeleted = fn => {
    if (typeof fn !== 'function') throw new TypeError('withSoftDeleted expects a function');
    return fn(prisma);
  };
  return client;
};

/**
 * Database connection health check
 */
export const checkDatabaseHealth = async prisma => {
  try {
    // Simple query to check database connectivity
    await prisma.$queryRaw`SELECT 1`;
    return { healthy: true, timestamp: new Date().toISOString() };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * Get database connection info and statistics
 */
export const getDatabaseInfo = async prisma => {
  try {
    // Get database version and basic info
    const [versionResult] = await prisma.$queryRaw`SELECT version()`;
    const { version } = versionResult;

    // Get connection pool status (if available)
    const poolStatus = {
      totalConnections: 10,
      environment: env.NODE_ENV
    };

    return {
      version: version.split(' ')[0], // Extract PostgreSQL version
      status: 'connected',
      pool: poolStatus,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    throw new Error(`Failed to get database info: ${error.message}`);
  }
};

/**
 * Gracefully disconnect from database
 */
export const disconnectDatabase = async (prisma, logger) => {
  try {
    await prisma.$disconnect();
    if (logger) logger.info('Database connection closed');
    else console.log('Database connection closed');
  } catch (error) {
    if (logger) logger.error('Error closing database connection:', error);
    else console.error('Error closing database connection:', error);
  }
};

/**
 * Transaction wrapper with retry logic
 */
export const withTransaction = async (prisma, operations, retries = 3) => {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await prisma.$transaction(operations, {
        maxWait: 5000, // 5 seconds
        timeout: 10000 // 10 seconds
      });
    } catch (error) {
      lastError = error;

      // Don't retry for certain types of errors
      if (error.code === 'P2002' || error.code === 'P2025') {
        throw error;
      }

      // Wait before retry (exponential backoff)
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise(resolve => global.setTimeout(resolve, delay));
        console.log(
          `🔄 Retrying transaction (attempt ${attempt + 1}/${retries}) after ${delay}ms delay`
        );
      }
    }
  }

  throw lastError;
};

/**
 * Export configured Prisma client for direct use
 */
export const prisma = createPrismaClient();

/**
 * Express database middleware
 * Sets up Prisma client for Express application
 */
export const databaseMiddleware = async app => {
  const client = createPrismaClient();

  try {
    // Test database connection
    await client.$connect();
    await client.$queryRaw`SELECT 1`;

    console.log('✅ Database connected successfully');

    // Store Prisma client in app.locals for access in routes
    app.locals.prisma = client;

    // Graceful shutdown handling
    const gracefulShutdown = async () => {
      console.log('📴 Disconnecting from database...');
      await client.$disconnect();
      console.log('✅ Database disconnected');
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
    process.on('beforeExit', gracefulShutdown);
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
};

export default {
  databaseMiddleware,
  withTransaction,
  checkDatabaseHealth,
  getDatabaseInfo,
  disconnectDatabase,
  prisma
};
