/**
 * Database Configuration and Connection Management
 *
 * This module provides centralized database configuration for the accounting API,
 * including connection pooling, health checks, error handling, and monitoring.
 */

import { PrismaClient } from '@prisma/client';
import { createSoftDeleteExtension } from 'prisma-extension-soft-delete';
import { isDevelopment, isProduction, isTest } from '../utils/index.js';

/**
 * Database configuration options based on environment
 */
const getDatabaseConfig = () => {
  const baseConfig = {
    // Datasource configuration
    datasources: {
      db: {
        url: process.env.DATABASE_URL
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

  // Apply prisma-extension-soft-delete to configured models that use soft deletes
  const softDeleteExt = createSoftDeleteExtension({
    models: {
      AccountDetail: true,
      AccountGeneral: true,
      Ledger: true
    },
    defaultConfig: {
      field: 'deletedAt',
      createValue: deleted => (deleted ? new Date() : null)
    }
  });

  // Extend the client instance with the soft-delete extension
  const extended = prisma.$extends(softDeleteExt);

  // Use the extended client from here on
  // Note: return the extended client so other modules using `prisma` get the extended API
  const client = extended;
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
      totalConnections: process.env.DATABASE_CONNECTION_LIMIT || 10,
      environment: process.env.NODE_ENV || 'development'
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
    if (logger) {
      logger.info('✅ Database connection closed gracefully');
    } else {
      console.log('✅ Database connection closed gracefully');
    }
  } catch (error) {
    if (logger) {
      logger.error('❌ Error closing database connection:', error);
    } else {
      console.error('❌ Error closing database connection:', error);
    }
  }
};

/**
 * Database middleware for request-level database access
 */
export const databaseMiddleware = async fastify => {
  // Create Prisma client instance
  const prisma = createPrismaClient();

  // Test initial connection
  try {
    const healthCheck = await checkDatabaseHealth(prisma);
    if (!healthCheck.healthy) {
      throw new Error(`Database health check failed: ${healthCheck.error}`);
    }

    fastify.log.info('✅ Database connection established successfully');

    // Log database info in development
    if (isDevelopment()) {
      const dbInfo = await getDatabaseInfo(prisma);
      fastify.log.info('📊 Database Info:', {
        version: dbInfo.version,
        environment: dbInfo.pool.environment
      });
    }
  } catch (error) {
    fastify.log.error('❌ Failed to establish database connection:', error);
    throw error;
  }

  // Decorate Fastify instance with Prisma client
  fastify.decorate('prisma', prisma);

  // Add database health check method
  fastify.decorate('checkDatabaseConnection', async () => {
    const health = await checkDatabaseHealth(prisma);
    return health.healthy;
  });

  // Add database info method
  fastify.decorate('getDatabaseInfo', async () => {
    return await getDatabaseInfo(prisma);
  });

  // Graceful shutdown hook
  fastify.addHook('onClose', async instance => {
    await disconnectDatabase(instance.prisma, instance.log);
  });

  // Request-level database connection check (optional, for critical operations)
  if (isProduction()) {
    fastify.addHook('onRequest', async request => {
      // Only check for database-dependent routes
      if (request.url.startsWith('/api/')) {
        const isHealthy = await request.server.checkDatabaseConnection();
        if (!isHealthy) {
          throw request.server.httpErrors.serviceUnavailable('Database connection unavailable');
        }
      }
    });
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
 * Database query performance monitoring
 */
export const queryPerformanceMiddleware = async fastify => {
  if (!isDevelopment()) return;

  // Wait for prisma to be available
  await fastify.after(() => {
    if (!fastify.prisma) {
      fastify.log.warn('Prisma client not available for query performance monitoring');
      return;
    }

    const originalQuery = fastify.prisma.$queryRaw;

    fastify.prisma.$queryRaw = async (...args) => {
      const start = Date.now();
      try {
        const result = await originalQuery.apply(fastify.prisma, args);
        const duration = Date.now() - start;

        // Log slow queries
        if (duration > 1000) {
          fastify.log.warn(`🐌 Slow query detected (${duration}ms):`, {
            query: args[0],
            duration: `${duration}ms`
          });
        }

        return result;
      } catch (error) {
        const duration = Date.now() - start;
        fastify.log.error(`❌ Query failed (${duration}ms):`, {
          query: args[0],
          error: error.message,
          duration: `${duration}ms`
        });
        throw error;
      }
    };
  });
};

/**
 * Export configured Prisma client for direct use
 */
export const prisma = createPrismaClient();

export default {
  databaseMiddleware,
  queryPerformanceMiddleware,
  withTransaction,
  checkDatabaseHealth,
  getDatabaseInfo,
  disconnectDatabase,
  prisma
};
