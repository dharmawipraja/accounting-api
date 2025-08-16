/**
 * Logging System Unit Tests
 *
 * Comprehensive tests for all logging components including logger configuration,
 * audit logging, performance monitoring, and log formatting.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import logger, {
  AUDIT_EVENTS,
  AuditLogger,
  PerformanceLogger,
  createRequestLogger,
  log,
  logFormats,
  logTemplates,
  loggerUtils
} from '../../../src/core/logging/index.js';

describe('Logging System', () => {
  beforeEach(() => {
    // Clear any existing log spy
    vi.clearAllMocks();
  });

  describe('Main Logger', () => {
    test('should create logger instance', () => {
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    test('should create child logger with context', () => {
      const childLogger = logger.child({ requestId: 'test-123' });

      expect(childLogger).toBeDefined();
      expect(typeof childLogger.info).toBe('function');
    });

    test('should have logger utilities', () => {
      expect(loggerUtils).toBeDefined();
      expect(typeof loggerUtils.child).toBe('function');
      expect(typeof loggerUtils.logAuth).toBe('function');
      expect(typeof loggerUtils.logBusiness).toBe('function');
    });
  });

  describe('Logger Utils', () => {
    test('should log authentication events', () => {
      const logSpy = vi.spyOn(logger, 'info');

      loggerUtils.logAuth('login', {
        userId: 'user123',
        ip: '127.0.0.1'
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.login',
          userId: 'user123',
          ip: '127.0.0.1'
        }),
        'Authentication: login'
      );
    });

    test('should log business events', () => {
      const logSpy = vi.spyOn(logger, 'info');

      loggerUtils.logBusiness('transaction.created', {
        transactionId: 'tx123',
        amount: 100
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'business.transaction.created',
          transactionId: 'tx123',
          amount: 100
        }),
        'Business event: transaction.created'
      );
    });

    test('should log security events', () => {
      const logSpy = vi.spyOn(logger, 'warn');

      loggerUtils.logSecurity('unauthorized_access', {
        ip: '192.168.1.1',
        url: '/admin'
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'security.unauthorized_access',
          ip: '192.168.1.1',
          url: '/admin'
        }),
        'Security event: unauthorized_access'
      );
    });

    test('should log performance metrics', () => {
      const logSpy = vi.spyOn(logger, 'info');

      loggerUtils.logPerformance('api_call', {
        duration: 150,
        endpoint: '/api/accounts'
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'performance',
          operation: 'api_call',
          duration: 150,
          endpoint: '/api/accounts'
        }),
        'Performance: api_call'
      );
    });
  });

  describe('Audit Logger', () => {
    test('should log basic audit events', () => {
      const logSpy = vi.spyOn(logger, 'info');

      AuditLogger.log(AUDIT_EVENTS.USER_CREATED, {
        userId: 'user123',
        actorUserId: 'admin456'
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AUDIT_EVENTS.USER_CREATED,
          userId: 'user123',
          actorUserId: 'admin456',
          timestamp: expect.any(String)
        }),
        `Audit: ${AUDIT_EVENTS.USER_CREATED}`
      );
    });

    test('should log authentication audit events', () => {
      const logSpy = vi.spyOn(logger, 'info');

      AuditLogger.logAuth(AUDIT_EVENTS.LOGIN_SUCCESS, 'user123', {
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
        requestId: 'req123'
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AUDIT_EVENTS.LOGIN_SUCCESS,
          userId: 'user123',
          ip: '127.0.0.1',
          userAgent: 'Mozilla/5.0',
          requestId: 'req123'
        }),
        `Audit: ${AUDIT_EVENTS.LOGIN_SUCCESS}`
      );
    });

    test('should log data change events', () => {
      const logSpy = vi.spyOn(logger, 'info');

      AuditLogger.logDataChange(AUDIT_EVENTS.ACCOUNT_UPDATED, 'user123', 'account', 'acc456', {
        before: { name: 'Old Name' },
        after: { name: 'New Name' },
        fields: ['name']
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AUDIT_EVENTS.ACCOUNT_UPDATED,
          userId: 'user123',
          resourceType: 'account',
          resourceId: 'acc456',
          changes: expect.objectContaining({
            before: { name: 'Old Name' },
            after: { name: 'New Name' },
            fields: ['name']
          })
        }),
        `Audit: ${AUDIT_EVENTS.ACCOUNT_UPDATED}`
      );
    });

    test('should log transaction events', () => {
      const logSpy = vi.spyOn(logger, 'info');

      AuditLogger.logTransaction(AUDIT_EVENTS.TRANSACTION_CREATED, 'user123', {
        id: 'tx789',
        amount: 250.5,
        currency: 'USD',
        accountFrom: 'acc123',
        accountTo: 'acc456',
        description: 'Test transfer'
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AUDIT_EVENTS.TRANSACTION_CREATED,
          userId: 'user123',
          transactionId: 'tx789',
          amount: 250.5,
          currency: 'USD',
          accountFrom: 'acc123',
          accountTo: 'acc456'
        }),
        `Audit: ${AUDIT_EVENTS.TRANSACTION_CREATED}`
      );
    });

    test('should log security events with severity', () => {
      const logSpy = vi.spyOn(logger, 'info');

      AuditLogger.logSecurity(
        AUDIT_EVENTS.UNAUTHORIZED_ACCESS,
        {
          ip: '192.168.1.100',
          url: '/admin/users',
          method: 'GET'
        },
        {
          severity: 'high',
          attempts: 3
        }
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AUDIT_EVENTS.UNAUTHORIZED_ACCESS,
          ip: '192.168.1.100',
          url: '/admin/users',
          method: 'GET',
          severity: 'high',
          attempts: 3
        }),
        `Audit: ${AUDIT_EVENTS.UNAUTHORIZED_ACCESS}`
      );
    });
  });

  describe('Performance Logger', () => {
    test('should log database query performance', () => {
      const logSpy = vi.spyOn(logger, 'debug');

      PerformanceLogger.logQuery('user.findMany', 'SELECT * FROM users WHERE active = true', 45.5, {
        recordCount: 150
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'database.query.performance',
          operation: 'user.findMany',
          duration: 45.5,
          recordCount: 150
        }),
        'Database query: user.findMany'
      );
    });

    test('should log slow queries as warnings', () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      PerformanceLogger.logQuery(
        'user.findMany',
        'SELECT * FROM users',
        2500 // Exceeds default threshold of 1000ms
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'database.query.performance',
          operation: 'user.findMany',
          duration: 2500
        }),
        'Slow database query: user.findMany'
      );
    });

    test('should log API endpoint performance', () => {
      const logSpy = vi.spyOn(logger, 'debug');

      PerformanceLogger.logEndpoint('GET', '/api/accounts', 125.3, 200, { userId: 'user123' });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'api.endpoint.performance',
          method: 'GET',
          path: '/api/accounts',
          duration: 125.3,
          statusCode: 200,
          userId: 'user123'
        }),
        'API endpoint: GET /api/accounts'
      );
    });

    test('should log business operation performance', () => {
      const logSpy = vi.spyOn(logger, 'info');

      PerformanceLogger.logBusinessOperation('account_creation', 89.7, {
        accountType: 'savings',
        userId: 'user123'
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'business.operation.performance',
          operation: 'account_creation',
          duration: 89.7,
          accountType: 'savings',
          userId: 'user123'
        }),
        'Business operation: account_creation'
      );
    });

    test('should create performance timer', () => {
      const timer = PerformanceLogger.createTimer('test_operation');

      expect(timer).toBeDefined();
      expect(typeof timer.end).toBe('function');

      const logSpy = vi.spyOn(logger, 'info');
      const duration = timer.end({ success: true });

      expect(typeof duration).toBe('number');
      expect(duration).toBeGreaterThan(0);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'business.operation.performance',
          operation: 'test_operation',
          duration: expect.any(Number),
          category: 'general',
          success: true
        }),
        'Business operation: test_operation'
      );
    });

    test('should sanitize sensitive data in queries', async () => {
      const { sanitizeQuery } = await import('../../../src/shared/utils/sanitization.js');

      const sensitiveQuery =
        "UPDATE users SET password='secret123', email='test@example.com' WHERE id=1";
      const sanitized = sanitizeQuery(sensitiveQuery);

      expect(sanitized).toContain("password='[REDACTED]'");
      expect(sanitized).not.toContain('secret123');
      expect(sanitized).toContain('test@example.com'); // Email should remain
    });

    test('should sanitize function arguments', async () => {
      const { sanitizeArgs } = await import('../../../src/shared/utils/sanitization.js');

      const args = [
        { email: 'test@example.com', password: 'secret123' },
        { token: 'jwt_token_here' },
        'normal_string'
      ];

      const sanitized = sanitizeArgs(args);

      expect(sanitized[0].email).toBe('test@example.com');
      expect(sanitized[0].password).toBe('[REDACTED]');
      expect(sanitized[1].token).toBe('[REDACTED]');
      expect(sanitized[2]).toBe('normal_string');
    });
  });

  describe('Request Logger', () => {
    test('should create request logger with context', () => {
      const mockRequest = {
        id: 'req123',
        method: 'GET',
        url: '/api/test',
        log: logger
      };

      const requestLogger = createRequestLogger(mockRequest);

      expect(requestLogger).toBeDefined();
      expect(typeof requestLogger.info).toBe('function');
      expect(typeof requestLogger.logAuth).toBe('function');
    });

    test('should log with request context', () => {
      const mockRequest = {
        id: 'req123',
        method: 'GET',
        url: '/api/test',
        log: logger
      };

      const requestLogger = createRequestLogger(mockRequest);
      const logSpy = vi.spyOn(logger, 'info');

      requestLogger.info('Test message', { data: 'test' });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'test',
          requestId: 'req123'
        }),
        'Test message'
      );
    });
  });

  describe('Log Templates', () => {
    test('should have authentication success template', () => {
      const template = logTemplates.authSuccess('user123', '127.0.0.1');

      expect(template).toEqual({
        event: 'auth.login.success',
        userId: 'user123',
        ip: '127.0.0.1',
        message: 'User user123 logged in successfully'
      });
    });

    test('should have transaction created template', () => {
      const template = logTemplates.transactionCreated('tx456', 250.5, 'user123');

      expect(template).toEqual({
        event: 'transaction.created',
        transactionId: 'tx456',
        amount: 250.5,
        userId: 'user123',
        message: 'Transaction tx456 created for amount 250.5'
      });
    });

    test('should have security event templates', () => {
      const template = logTemplates.unauthorizedAccess('192.168.1.1', '/admin', 'user123');

      expect(template).toEqual({
        event: 'security.unauthorized_access',
        ip: '192.168.1.1',
        url: '/admin',
        userId: 'user123',
        severity: 'high',
        message: 'Unauthorized access attempt to /admin from 192.168.1.1'
      });
    });
  });

  describe('Log Formats', () => {
    test('should have development format configuration', () => {
      expect(logFormats.development).toBeDefined();
      expect(logFormats.development.level).toBe('debug');
      expect(logFormats.development.transport).toBeDefined();
    });

    test('should have production format configuration', () => {
      expect(logFormats.production).toBeDefined();
      expect(logFormats.production.level).toBe('info');
      expect(logFormats.production.redact).toBeDefined();
    });

    test('should have redaction rules for sensitive data', () => {
      expect(logFormats.production.redact.paths).toContain('password');
      expect(logFormats.production.redact.paths).toContain('token');
      expect(logFormats.production.redact.censor).toBe('[REDACTED]');
    });
  });

  describe('Convenience Log Functions', () => {
    test('should provide quick log functions', () => {
      expect(typeof log.info).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.auth).toBe('function');
      expect(typeof log.business).toBe('function');
    });

    test('should log info messages', () => {
      const logSpy = vi.spyOn(logger, 'info');

      log.info('Test info message', { test: true });

      expect(logSpy).toHaveBeenCalledWith({ test: true }, 'Test info message');
    });

    test('should log error messages with error objects', () => {
      const logSpy = vi.spyOn(logger, 'error');
      const error = new Error('Test error');

      log.error('Error occurred', error, { context: 'test' });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          err: error,
          context: 'test'
        }),
        'Error occurred'
      );
    });
  });

  describe('AUDIT_EVENTS Constants', () => {
    test('should have authentication events', () => {
      expect(AUDIT_EVENTS.LOGIN_SUCCESS).toBe('auth.login.success');
      expect(AUDIT_EVENTS.LOGIN_FAILURE).toBe('auth.login.failure');
      expect(AUDIT_EVENTS.LOGOUT).toBe('auth.logout');
    });

    test('should have user management events', () => {
      expect(AUDIT_EVENTS.USER_CREATED).toBe('user.created');
      expect(AUDIT_EVENTS.USER_UPDATED).toBe('user.updated');
      expect(AUDIT_EVENTS.USER_DELETED).toBe('user.deleted');
    });

    test('should have transaction events', () => {
      expect(AUDIT_EVENTS.TRANSACTION_CREATED).toBe('transaction.created');
      expect(AUDIT_EVENTS.TRANSACTION_APPROVED).toBe('transaction.approved');
      expect(AUDIT_EVENTS.TRANSACTION_REJECTED).toBe('transaction.rejected');
    });

    test('should have security events', () => {
      expect(AUDIT_EVENTS.UNAUTHORIZED_ACCESS).toBe('security.unauthorized.access');
      expect(AUDIT_EVENTS.RATE_LIMIT_EXCEEDED).toBe('security.rate_limit.exceeded');
      expect(AUDIT_EVENTS.SUSPICIOUS_ACTIVITY).toBe('security.suspicious.activity');
    });
  });
});
