/**
 * Performance Logger
 *
 * Provides performance monitoring and metrics collection for
 * application performance analysis and optimization.
 */

import { sanitizeArgs, sanitizeQuery } from '../../shared/utils/sanitization.js';
import logger from './logger.js';

/**
 * Performance metrics collector
 */
export class PerformanceLogger {
  /**
   * Log database query performance
   */
  static logQuery(operation, query, duration, metadata = {}) {
    const metrics = {
      event: 'database.query.performance',
      operation,
      query: sanitizeQuery(query),
      duration,
      timestamp: new Date().toISOString(),
      ...metadata
    };

    // Log slow queries as warnings
    if (duration > this.getSlowQueryThreshold()) {
      logger.warn(metrics, `Slow database query: ${operation}`);
    } else {
      logger.debug(metrics, `Database query: ${operation}`);
    }

    // Collect metrics for monitoring
    this.collectMetric('query_duration', duration, { operation });
  }

  /**
   * Log API endpoint performance
   */
  static logEndpoint(method, path, duration, statusCode, metadata = {}) {
    const metrics = {
      event: 'api.endpoint.performance',
      method,
      path,
      duration,
      statusCode,
      timestamp: new Date().toISOString(),
      ...metadata
    };

    // Log slow endpoints
    if (duration > this.getSlowEndpointThreshold()) {
      logger.warn(metrics, `Slow API endpoint: ${method} ${path}`);
    } else {
      logger.debug(metrics, `API endpoint: ${method} ${path}`);
    }

    // Collect metrics
    this.collectMetric('endpoint_duration', duration, { method, path, statusCode });
  }

  /**
   * Log memory usage
   */
  static logMemoryUsage(context = 'general') {
    const memUsage = process.memoryUsage();
    const metrics = {
      event: 'system.memory.usage',
      context,
      memory: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers
      },
      timestamp: new Date().toISOString()
    };

    // Log high memory usage as warning
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    if (heapUsagePercent > 80) {
      logger.warn(metrics, 'High memory usage detected');
    } else {
      logger.debug(metrics, 'Memory usage recorded');
    }

    this.collectMetric('memory_usage', memUsage.heapUsed, { context });
  }

  /**
   * Log business operation performance
   */
  static logBusinessOperation(operation, duration, details = {}) {
    const metrics = {
      event: 'business.operation.performance',
      operation,
      duration,
      timestamp: new Date().toISOString(),
      ...details
    };

    logger.info(metrics, `Business operation: ${operation}`);
    this.collectMetric('business_operation_duration', duration, { operation });
  }

  /**
   * Log external service call performance
   */
  static logExternalService(service, operation, duration, success, metadata = {}) {
    const metrics = {
      event: 'external.service.performance',
      service,
      operation,
      duration,
      success,
      timestamp: new Date().toISOString(),
      ...metadata
    };

    if (!success) {
      logger.warn(metrics, `External service failure: ${service}.${operation}`);
    } else if (duration > this.getSlowExternalServiceThreshold()) {
      logger.warn(metrics, `Slow external service: ${service}.${operation}`);
    } else {
      logger.debug(metrics, `External service: ${service}.${operation}`);
    }

    this.collectMetric('external_service_duration', duration, { service, operation, success });
  }

  /**
   * Performance measurement decorator
   */
  static measure(operation, category = 'general') {
    return (target, propertyKey, descriptor) => {
      const originalMethod = descriptor.value;

      descriptor.value = async function (...args) {
        const startTime = process.hrtime.bigint();

        try {
          const result = await originalMethod.apply(this, args);
          const endTime = process.hrtime.bigint();
          const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds

          PerformanceLogger.logBusinessOperation(operation, duration, {
            category,
            success: true,
            args: sanitizeArgs(args)
          });

          return result;
        } catch (error) {
          const endTime = process.hrtime.bigint();
          const duration = Number(endTime - startTime) / 1000000;

          PerformanceLogger.logBusinessOperation(operation, duration, {
            category,
            success: false,
            error: error.message,
            args: sanitizeArgs(args)
          });

          throw error;
        }
      };

      return descriptor;
    };
  }

  /**
   * Create performance timer
   */
  static createTimer(operation, category = 'general') {
    const startTime = process.hrtime.bigint();

    return {
      end: (metadata = {}) => {
        const endTime = process.hrtime.bigint();
        const duration = Number(endTime - startTime) / 1000000;

        this.logBusinessOperation(operation, duration, {
          category,
          ...metadata
        });

        return duration;
      }
    };
  }

  /**
   * Collect metrics for monitoring systems
   */
  static collectMetric(name, value, labels = {}) {
    // In a real implementation, this would send metrics to
    // monitoring systems like Prometheus, StatsD, etc.
    logger.debug(
      {
        metric: name,
        value,
        labels,
        timestamp: new Date().toISOString()
      },
      `Metric collected: ${name}`
    );
  }

  /**
   * Get slow query threshold
   */
  static getSlowQueryThreshold() {
    return parseInt(process.env.SLOW_QUERY_THRESHOLD) || 1000; // 1 second default
  }

  /**
   * Get slow endpoint threshold
   */
  static getSlowEndpointThreshold() {
    return parseInt(process.env.SLOW_ENDPOINT_THRESHOLD) || 2000; // 2 seconds default
  }

  /**
   * Get slow external service threshold
   */
  static getSlowExternalServiceThreshold() {
    return parseInt(process.env.SLOW_EXTERNAL_SERVICE_THRESHOLD) || 5000; // 5 seconds default
  }
}

/**
 * Performance monitoring middleware
 */
export const performanceMiddleware = {
  /**
   * Register performance monitoring hooks
   */
  register: async fastify => {
    // Monitor endpoint performance
    fastify.addHook('onRequest', async (request, _reply) => {
      request.performanceStart = process.hrtime.bigint();
    });

    fastify.addHook('onResponse', async (request, reply) => {
      if (request.performanceStart) {
        const endTime = process.hrtime.bigint();
        const duration = Number(endTime - request.performanceStart) / 1000000;

        PerformanceLogger.logEndpoint(request.method, request.url, duration, reply.statusCode, {
          requestId: request.id,
          userId: request.user?.id
        });
      }
    });

    // Monitor memory usage periodically
    if (process.env.MEMORY_MONITORING_ENABLED === 'true') {
      globalThis.setInterval(
        () => {
          PerformanceLogger.logMemoryUsage('periodic');
        },
        parseInt(process.env.MEMORY_MONITORING_INTERVAL) || 60000
      ); // Default 1 minute
    }
  }
};

/**
 * Database performance monitoring
 */
export const withQueryPerformance = prisma => {
  return prisma.$extends({
    query: {
      $allOperations({ operation, model, args, query }) {
        const startTime = process.hrtime.bigint();

        return query(args).finally(() => {
          const endTime = process.hrtime.bigint();
          const duration = Number(endTime - startTime) / 1000000;

          PerformanceLogger.logQuery(`${model}.${operation}`, JSON.stringify(args), duration, {
            model,
            operation
          });
        });
      }
    }
  });
};
