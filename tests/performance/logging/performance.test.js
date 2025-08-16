/**
 * Logging Performance Tests
 *
 * Performance benchmarks for logging system to ensure minimal
 * impact on application performance and resource usage.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import logger, { AuditLogger, PerformanceLogger, log } from '../../../src/core/logging/index.js';

describe('Logging Performance', () => {
  beforeEach(() => {
    // Clear any existing mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const measurePerformance = async (operation, iterations = 1000) => {
    const startMemory = process.memoryUsage();
    const startTime = process.hrtime.bigint();

    for (let i = 0; i < iterations; i++) {
      await operation(i);
    }

    const endTime = process.hrtime.bigint();
    const endMemory = process.memoryUsage();

    const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    const memoryDelta = endMemory.heapUsed - startMemory.heapUsed;

    return {
      duration,
      averagePerOperation: duration / iterations,
      memoryDelta,
      averageMemoryPerOperation: memoryDelta / iterations
    };
  };

  describe('Basic Logging Performance', () => {
    test('should handle high volume of simple log messages efficiently', async () => {
      const metrics = await measurePerformance(i => {
        logger.info({ index: i }, `Test message ${i}`);
      }, 10000);

      // Should complete 10,000 log operations in reasonable time
      expect(metrics.duration).toBeLessThan(5000); // Less than 5 seconds
      expect(metrics.averagePerOperation).toBeLessThan(1); // Less than 1ms per operation
    });

    test('should handle large log objects efficiently', async () => {
      const largeObject = {
        user: { id: 'user123', name: 'John Doe', email: 'john@example.com' },
        transaction: {
          id: 'tx456',
          amount: 1000.5,
          description: 'Large transaction with lots of metadata',
          metadata: {
            category: 'transfer',
            subcategory: 'internal',
            tags: ['urgent', 'verified', 'processed'],
            auditTrail: Array(100)
              .fill()
              .map((_, i) => ({ step: i, timestamp: new Date() }))
          }
        }
      };

      const metrics = await measurePerformance(i => {
        logger.info({ ...largeObject, index: i }, `Large object log ${i}`);
      }, 1000);

      expect(metrics.averagePerOperation).toBeLessThan(5); // Less than 5ms per operation
    });

    test('should handle concurrent logging efficiently', async () => {
      const concurrentOps = 100;
      const opsPerConcurrent = 100;

      const startTime = process.hrtime.bigint();

      const promises = Array(concurrentOps)
        .fill()
        .map(async (_, i) => {
          for (let j = 0; j < opsPerConcurrent; j++) {
            logger.info({ threadId: i, opId: j }, `Concurrent log ${i}-${j}`);
          }
        });

      await Promise.all(promises);

      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000;
      const totalOps = concurrentOps * opsPerConcurrent;

      expect(duration).toBeLessThan(10000); // Less than 10 seconds
      expect(duration / totalOps).toBeLessThan(1); // Less than 1ms per operation
    });
  });

  describe('Audit Logging Performance', () => {
    test('should handle high volume audit events efficiently', async () => {
      const metrics = await measurePerformance(i => {
        AuditLogger.log('user.login', {
          userId: `user${i}`,
          ip: '127.0.0.1',
          userAgent: 'Mozilla/5.0 Test Agent',
          timestamp: new Date().toISOString()
        });
      }, 5000);

      expect(metrics.averagePerOperation).toBeLessThan(2); // Less than 2ms per audit log
    });

    test('should handle complex audit events with change tracking', async () => {
      const metrics = await measurePerformance(i => {
        AuditLogger.logDataChange('account.updated', `user${i}`, 'account', `account${i}`, {
          before: {
            name: `Old Account ${i}`,
            balance: 1000.0,
            metadata: { type: 'savings', interest: 0.02 }
          },
          after: {
            name: `New Account ${i}`,
            balance: 1500.5,
            metadata: { type: 'checking', interest: 0.01 }
          },
          fields: ['name', 'balance', 'metadata.type', 'metadata.interest']
        });
      }, 1000);

      expect(metrics.averagePerOperation).toBeLessThan(3); // Less than 3ms per complex audit log
    });
  });

  describe('Performance Logging Performance', () => {
    test('should handle database query logging with minimal overhead', async () => {
      const metrics = await measurePerformance(i => {
        PerformanceLogger.logQuery(
          'user.findMany',
          `SELECT * FROM users WHERE active = true AND id > ${i}`,
          Math.random() * 100, // Random duration
          { recordCount: Math.floor(Math.random() * 1000) }
        );
      }, 2000);

      expect(metrics.averagePerOperation).toBeLessThan(1.5); // Less than 1.5ms per query log
    });

    test('should handle API endpoint logging efficiently', async () => {
      const endpoints = [
        { method: 'GET', path: '/api/users' },
        { method: 'POST', path: '/api/accounts' },
        { method: 'PUT', path: '/api/transactions' },
        { method: 'DELETE', path: '/api/ledgers' }
      ];

      const metrics = await measurePerformance(i => {
        const endpoint = endpoints[i % endpoints.length];
        PerformanceLogger.logEndpoint(
          endpoint.method,
          endpoint.path,
          Math.random() * 500, // Random duration
          200,
          { userId: `user${i}`, requestId: `req${i}` }
        );
      }, 3000);

      expect(metrics.averagePerOperation).toBeLessThan(1); // Less than 1ms per endpoint log
    });
  });

  describe('Memory Usage', () => {
    test('should not cause memory leaks with continuous logging', async () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // Log continuously for a period
      for (let i = 0; i < 10000; i++) {
        logger.info({ index: i, data: `test data ${i}` }, `Memory test ${i}`);

        // Force garbage collection periodically if available
        if (global.gc && i % 1000 === 0) {
          global.gc();
        }
      }

      // Wait a bit for async operations
      await new Promise(resolve => globalThis.setTimeout(resolve, 100));

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (less than 50MB)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });

    test('should handle object serialization efficiently', async () => {
      const createComplexObject = id => ({
        id,
        timestamp: new Date(),
        user: {
          id: `user${id}`,
          profile: {
            name: `User ${id}`,
            preferences: {
              theme: 'dark',
              language: 'en',
              notifications: {
                email: true,
                sms: false,
                push: true
              }
            }
          }
        },
        data: Array(50)
          .fill()
          .map((_, i) => ({ item: i, value: Math.random() }))
      });

      const initialMemory = process.memoryUsage().heapUsed;

      for (let i = 0; i < 1000; i++) {
        const complexObject = createComplexObject(i);
        logger.info(complexObject, `Complex object ${i}`);
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Should handle complex objects without excessive memory usage
      expect(memoryIncrease).toBeLessThan(20 * 1024 * 1024); // Less than 20MB
    });
  });

  describe('Error Handling Performance', () => {
    test('should handle logging errors without performance degradation', async () => {
      // Mock logger to occasionally fail
      const originalInfo = logger.info;
      let callCount = 0;

      logger.info = vi.fn().mockImplementation((...args) => {
        callCount++;
        if (callCount % 100 === 0) {
          throw new Error('Simulated logging error');
        }
        return originalInfo.apply(logger, args);
      });

      const metrics = await measurePerformance(i => {
        try {
          log.info({ index: i }, `Error handling test ${i}`);
        } catch {
          // Should handle errors gracefully
        }
      }, 1000);

      // Restore original logger
      logger.info = originalInfo;

      // Performance should not be significantly impacted by occasional errors
      expect(metrics.averagePerOperation).toBeLessThan(2); // Less than 2ms per operation
    });
  });

  describe('Sanitization Performance', () => {
    test('should sanitize sensitive data efficiently', async () => {
      const sensitiveData = {
        username: 'testuser',
        password: 'secret123',
        email: 'test@example.com',
        creditCard: '4111-1111-1111-1111',
        ssn: '123-45-6789',
        token: 'jwt_token_here',
        normalData: 'This is normal data that should not be redacted'
      };

      const metrics = await measurePerformance(i => {
        logger.info({ ...sensitiveData, index: i }, `Sanitization test ${i}`);
      }, 2000);

      expect(metrics.averagePerOperation).toBeLessThan(2); // Less than 2ms per operation with sanitization
    });

    test('should sanitize SQL queries efficiently', async () => {
      const sensitiveQueries = [
        "SELECT * FROM users WHERE password = 'secret123'",
        "UPDATE accounts SET token = 'jwt_token' WHERE id = 1",
        "INSERT INTO sessions (user_id, session_token) VALUES (1, 'session_abc123')",
        "DELETE FROM passwords WHERE value = 'old_password'"
      ];

      const metrics = await measurePerformance(async i => {
        const { sanitizeQuery } = await import('../../../src/shared/utils/sanitization.js');
        const query = sensitiveQueries[i % sensitiveQueries.length];
        const sanitized = sanitizeQuery(query);
        PerformanceLogger.logQuery('test.query', sanitized, Math.random() * 50);
      }, 1000);

      expect(metrics.averagePerOperation).toBeLessThan(3); // Less than 3ms per query sanitization
    });
  });

  describe('Benchmarks', () => {
    test('should establish baseline performance metrics', async () => {
      const benchmarks = {
        simpleLog: await measurePerformance(i => {
          logger.info(`Simple message ${i}`);
        }, 5000),

        structuredLog: await measurePerformance(i => {
          logger.info({ userId: `user${i}`, action: 'test' }, `Structured message ${i}`);
        }, 5000),

        auditLog: await measurePerformance(i => {
          AuditLogger.log('test.event', { userId: `user${i}`, data: `test${i}` });
        }, 2000),

        performanceLog: await measurePerformance(i => {
          PerformanceLogger.logBusinessOperation('test_op', Math.random() * 100, { index: i });
        }, 2000)
      };

      console.log('Logging Performance Benchmarks:', {
        simpleLog: `${benchmarks.simpleLog.averagePerOperation.toFixed(3)}ms avg`,
        structuredLog: `${benchmarks.structuredLog.averagePerOperation.toFixed(3)}ms avg`,
        auditLog: `${benchmarks.auditLog.averagePerOperation.toFixed(3)}ms avg`,
        performanceLog: `${benchmarks.performanceLog.averagePerOperation.toFixed(3)}ms avg`
      });

      // All operations should be sub-millisecond on average
      expect(benchmarks.simpleLog.averagePerOperation).toBeLessThan(1);
      expect(benchmarks.structuredLog.averagePerOperation).toBeLessThan(1.5);
      expect(benchmarks.auditLog.averagePerOperation).toBeLessThan(2);
      expect(benchmarks.performanceLog.averagePerOperation).toBeLessThan(2);
    });
  });
});
