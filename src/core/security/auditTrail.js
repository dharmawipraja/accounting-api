/**
 * Security Audit Trail and Event Logging
 *
 * This module provides comprehensive security event logging and audit trail
 * functionality for tracking security-related activities.
 */

import { z } from 'zod';

/**
 * Security event types
 */
export const SecurityEventType = {
  // Authentication events
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILURE: 'login_failure',
  LOGOUT: 'logout',
  PASSWORD_CHANGE: 'password_change',
  PASSWORD_RESET_REQUEST: 'password_reset_request',
  PASSWORD_RESET_SUCCESS: 'password_reset_success',

  // Authorization events
  ACCESS_GRANTED: 'access_granted',
  ACCESS_DENIED: 'access_denied',
  PERMISSION_ESCALATION: 'permission_escalation',

  // Data access events
  DATA_ACCESS: 'data_access',
  DATA_EXPORT: 'data_export',
  SENSITIVE_DATA_ACCESS: 'sensitive_data_access',

  // Administrative events
  USER_CREATED: 'user_created',
  USER_UPDATED: 'user_updated',
  USER_DELETED: 'user_deleted',
  ROLE_CHANGED: 'role_changed',

  // Security events
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  SUSPICIOUS_ACTIVITY: 'suspicious_activity',
  SQL_INJECTION_ATTEMPT: 'sql_injection_attempt',
  XSS_ATTEMPT: 'xss_attempt',
  BRUTE_FORCE_ATTEMPT: 'brute_force_attempt',

  // System events
  CONFIG_CHANGE: 'config_change',
  SECURITY_POLICY_CHANGE: 'security_policy_change',
  BACKUP_CREATED: 'backup_created',
  BACKUP_RESTORED: 'backup_restored'
};

/**
 * Security event risk levels
 */
export const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * Zod schema for security events
 */
export const securityEventSchema = z.object({
  eventType: z.nativeEnum(SecurityEventType),
  riskLevel: z.nativeEnum(RiskLevel),
  timestamp: z.date(),
  userId: z.string().optional(),
  userEmail: z.string().email().optional(),
  ipAddress: z.string(),
  userAgent: z.string().optional(),
  resource: z.string().optional(),
  action: z.string().optional(),
  details: z.record(z.any()).optional(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
  requestId: z.string().optional(),
  sessionId: z.string().optional()
});

/**
 * Security audit logger class
 */
export class SecurityAuditLogger {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Log a security event
   */
  logEvent(event) {
    try {
      // Validate event data
      const validatedEvent = securityEventSchema.parse(event);

      // Create structured log entry
      const logEntry = {
        security: true,
        eventType: validatedEvent.eventType,
        riskLevel: validatedEvent.riskLevel,
        timestamp: validatedEvent.timestamp.toISOString(),
        userId: validatedEvent.userId,
        userEmail: validatedEvent.userEmail,
        ipAddress: validatedEvent.ipAddress,
        userAgent: validatedEvent.userAgent,
        resource: validatedEvent.resource,
        action: validatedEvent.action,
        details: validatedEvent.details,
        success: validatedEvent.success,
        errorMessage: validatedEvent.errorMessage,
        requestId: validatedEvent.requestId,
        sessionId: validatedEvent.sessionId
      };

      // Log at appropriate level based on risk
      switch (validatedEvent.riskLevel) {
        case RiskLevel.CRITICAL:
          this.logger.error(logEntry, `Security event: ${validatedEvent.eventType}`);
          break;
        case RiskLevel.HIGH:
          this.logger.warn(logEntry, `Security event: ${validatedEvent.eventType}`);
          break;
        case RiskLevel.MEDIUM:
          this.logger.info(logEntry, `Security event: ${validatedEvent.eventType}`);
          break;
        case RiskLevel.LOW:
        default:
          this.logger.debug(logEntry, `Security event: ${validatedEvent.eventType}`);
          break;
      }

      return true;
    } catch (error) {
      this.logger.error(
        {
          error: error.message,
          event
        },
        'Failed to log security event'
      );
      return false;
    }
  }

  /**
   * Log authentication success
   */
  logLoginSuccess(userId, userEmail, ipAddress, userAgent, requestId) {
    return this.logEvent({
      eventType: SecurityEventType.LOGIN_SUCCESS,
      riskLevel: RiskLevel.LOW,
      timestamp: new Date(),
      userId,
      userEmail,
      ipAddress,
      userAgent,
      action: 'login',
      success: true,
      requestId
    });
  }

  /**
   * Log authentication failure
   */
  logLoginFailure(userEmail, ipAddress, userAgent, errorMessage, requestId) {
    return this.logEvent({
      eventType: SecurityEventType.LOGIN_FAILURE,
      riskLevel: RiskLevel.MEDIUM,
      timestamp: new Date(),
      userEmail,
      ipAddress,
      userAgent,
      action: 'login',
      success: false,
      errorMessage,
      requestId
    });
  }

  /**
   * Log access denial
   */
  logAccessDenied(userId, userEmail, resource, action, ipAddress, userAgent, requestId) {
    return this.logEvent({
      eventType: SecurityEventType.ACCESS_DENIED,
      riskLevel: RiskLevel.MEDIUM,
      timestamp: new Date(),
      userId,
      userEmail,
      ipAddress,
      userAgent,
      resource,
      action,
      success: false,
      requestId
    });
  }

  /**
   * Log suspicious activity
   */
  logSuspiciousActivity(description, ipAddress, userAgent, userId, details, requestId) {
    return this.logEvent({
      eventType: SecurityEventType.SUSPICIOUS_ACTIVITY,
      riskLevel: RiskLevel.HIGH,
      timestamp: new Date(),
      userId,
      ipAddress,
      userAgent,
      action: 'suspicious_activity',
      details: { description, ...details },
      success: false,
      requestId
    });
  }

  /**
   * Log rate limit exceeded
   */
  logRateLimitExceeded(ipAddress, userAgent, userId, endpoint, requestId) {
    return this.logEvent({
      eventType: SecurityEventType.RATE_LIMIT_EXCEEDED,
      riskLevel: RiskLevel.MEDIUM,
      timestamp: new Date(),
      userId,
      ipAddress,
      userAgent,
      resource: endpoint,
      action: 'rate_limit_check',
      success: false,
      requestId
    });
  }

  /**
   * Log sensitive data access
   */
  logSensitiveDataAccess(userId, userEmail, resource, action, ipAddress, userAgent, requestId) {
    return this.logEvent({
      eventType: SecurityEventType.SENSITIVE_DATA_ACCESS,
      riskLevel: RiskLevel.MEDIUM,
      timestamp: new Date(),
      userId,
      userEmail,
      ipAddress,
      userAgent,
      resource,
      action,
      success: true,
      requestId
    });
  }

  /**
   * Log data export
   */
  logDataExport(userId, userEmail, exportType, recordCount, ipAddress, userAgent, requestId) {
    return this.logEvent({
      eventType: SecurityEventType.DATA_EXPORT,
      riskLevel: RiskLevel.HIGH,
      timestamp: new Date(),
      userId,
      userEmail,
      ipAddress,
      userAgent,
      action: 'export',
      details: { exportType, recordCount },
      success: true,
      requestId
    });
  }
}

/**
 * Fastify plugin for security audit logging
 */
export async function auditTrailPlugin(fastify, options = {}) {
  const { enableAuditLogging = true } = options;

  if (!enableAuditLogging) {
    return;
  }

  // Create security audit logger instance
  const securityLogger = new SecurityAuditLogger(fastify.log);

  // Decorate fastify instance with audit logger
  fastify.decorate('securityAudit', securityLogger);

  // Auto-log authentication events
  fastify.addHook('onResponse', async (request, reply) => {
    // Log successful authentication if JWT was used
    if (request.user && reply.statusCode === 200 && request.url.includes('/auth/')) {
      securityLogger.logLoginSuccess(
        request.user.id,
        request.user.email,
        request.ip,
        request.headers['user-agent'],
        request.id
      );
    }

    // Log authentication failures
    if (reply.statusCode === 401 && request.url.includes('/auth/')) {
      securityLogger.logLoginFailure(
        request.body?.email,
        request.ip,
        request.headers['user-agent'],
        'Authentication failed',
        request.id
      );
    }

    // Log access denials
    if (reply.statusCode === 403) {
      securityLogger.logAccessDenied(
        request.user?.id,
        request.user?.email,
        request.url,
        request.method,
        request.ip,
        request.headers['user-agent'],
        request.id
      );
    }

    // Log rate limit exceeded
    if (reply.statusCode === 429) {
      securityLogger.logRateLimitExceeded(
        request.ip,
        request.headers['user-agent'],
        request.user?.id,
        request.url,
        request.id
      );
    }
  });
}
