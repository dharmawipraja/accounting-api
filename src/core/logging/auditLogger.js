/**
 * Audit Logger
 *
 * Provides comprehensive audit trail logging for user actions,
 * data changes, and security events for compliance and debugging.
 */

import { env } from '../../config/env.js';
import { logger } from './logger.js';

/**
 * Audit event types
 */
export const AUDIT_EVENTS = {
  // Authentication events
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  LOGOUT: 'auth.logout',
  TOKEN_REFRESH: 'auth.token.refresh',
  PASSWORD_CHANGE: 'auth.password.change',
  PASSWORD_RESET: 'auth.password.reset',
  ACCOUNT_LOCKED: 'auth.account.locked',

  // User management events
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DELETED: 'user.deleted',
  USER_ROLE_CHANGED: 'user.role.changed',
  USER_STATUS_CHANGED: 'user.status.changed',

  // Account management events
  ACCOUNT_CREATED: 'account.created',
  ACCOUNT_UPDATED: 'account.updated',
  ACCOUNT_DELETED: 'account.deleted',
  ACCOUNT_BALANCE_CHANGED: 'account.balance.changed',

  // Transaction events
  TRANSACTION_CREATED: 'transaction.created',
  TRANSACTION_UPDATED: 'transaction.updated',
  TRANSACTION_DELETED: 'transaction.deleted',
  TRANSACTION_APPROVED: 'transaction.approved',
  TRANSACTION_REJECTED: 'transaction.rejected',

  // Ledger events
  LEDGER_ENTRY_CREATED: 'ledger.entry.created',
  LEDGER_ENTRY_UPDATED: 'ledger.entry.updated',
  LEDGER_ENTRY_DELETED: 'ledger.entry.deleted',
  LEDGER_RECONCILED: 'ledger.reconciled',

  // Security events
  UNAUTHORIZED_ACCESS: 'security.unauthorized.access',
  RATE_LIMIT_EXCEEDED: 'security.rate_limit.exceeded',
  SUSPICIOUS_ACTIVITY: 'security.suspicious.activity',
  DATA_EXPORT: 'security.data.export',
  BULK_OPERATION: 'security.bulk.operation',

  // System events
  SYSTEM_BACKUP: 'system.backup',
  SYSTEM_RESTORE: 'system.restore',
  CONFIGURATION_CHANGED: 'system.config.changed',
  MAINTENANCE_MODE: 'system.maintenance'
};

/**
 * Audit Logger class
 */
export class AuditLogger {
  /**
   * Log audit event
   */
  static log(event, data = {}) {
    const auditEntry = {
      event,
      timestamp: new Date().toISOString(),
      ...data
    };

    // Log to main logger
    logger.info(auditEntry, `Audit: ${event}`);

    // Could also log to separate audit log file or database
    if (env.AUDIT_LOG_SEPARATE === 'true') {
      this.logToAuditFile(auditEntry);
    }
  }

  /**
   * Log authentication events
   */
  static logAuth(event, userId, requestData = {}) {
    this.log(event, {
      userId,
      ip: requestData.ip,
      userAgent: requestData.userAgent,
      requestId: requestData.requestId,
      email: requestData.email,
      reason: requestData.reason
    });
  }

  /**
   * Log user management events
   */
  static logUserEvent(event, actorUserId, targetUserId, changes = {}) {
    this.log(event, {
      actorUserId,
      targetUserId,
      changes,
      previousValues: changes.before,
      newValues: changes.after
    });
  }

  /**
   * Log data change events
   */
  static logDataChange(event, userId, resourceType, resourceId, changes = {}) {
    this.log(event, {
      userId,
      resourceType,
      resourceId,
      changes: {
        before: changes.before,
        after: changes.after,
        fields: changes.fields || []
      }
    });
  }

  /**
   * Log financial transaction events
   */
  static logTransaction(event, userId, transactionData) {
    this.log(event, {
      userId,
      transactionId: transactionData.id,
      amount: transactionData.amount,
      currency: transactionData.currency,
      accountFrom: transactionData.accountFrom,
      accountTo: transactionData.accountTo,
      description: transactionData.description,
      metadata: transactionData.metadata
    });
  }

  /**
   * Log security events
   */
  static logSecurity(event, requestData, details = {}) {
    this.log(event, {
      ip: requestData.ip,
      userAgent: requestData.userAgent,
      requestId: requestData.requestId,
      userId: requestData.userId,
      url: requestData.url,
      method: requestData.method,
      severity: details.severity || 'medium',
      ...details
    });
  }

  /**
   * Log bulk operations
   */
  static logBulkOperation(event, userId, operation) {
    this.log(event, {
      userId,
      operation: operation.type,
      recordCount: operation.count,
      resourceType: operation.resourceType,
      filters: operation.filters,
      duration: operation.duration
    });
  }

  /**
   * Log administrative actions
   */
  static logAdmin(event, adminUserId, details = {}) {
    this.log(event, {
      adminUserId,
      adminAction: true,
      ...details
    });
  }

  /**
   * Log compliance events
   */
  static logCompliance(event, data = {}) {
    this.log(event, {
      complianceEvent: true,
      ...data
    });
  }

  /**
   * Log to separate audit file (if configured)
   */
  static logToAuditFile(auditEntry) {
    // Implementation would depend on your audit storage requirements
    // Could write to file, database, or external audit service
    console.log('[AUDIT]', JSON.stringify(auditEntry));
  }
}

/**
 * Audit middleware for request tracking
 */
export const auditMiddleware = {};

/**
 * Request audit decorator
 */
export const withAudit = (event, options = {}) => {
  return handler => {
    return async (request, reply) => {
      const startTime = Date.now();

      try {
        const result = await handler(request, reply);

        // Log successful operation
        if (options.logSuccess !== false) {
          AuditLogger.log(event, {
            ...request.auditContext,
            userId: request.user?.id,
            duration: Date.now() - startTime,
            success: true,
            ...options.data
          });
        }

        return result;
      } catch (error) {
        // Log failed operation
        if (options.logFailure !== false) {
          AuditLogger.log(`${event}.failed`, {
            ...request.auditContext,
            userId: request.user?.id,
            duration: Date.now() - startTime,
            success: false,
            error: error.message,
            ...options.data
          });
        }

        throw error;
      }
    };
  };
};
