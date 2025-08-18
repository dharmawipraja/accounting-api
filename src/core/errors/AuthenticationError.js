/**
 * Authentication Error Class
 *
 * Handles authentication-related errors including token validation,
 * login failures, and session management issues.
 */

import { isDevelopment } from '../../config/env.js';
import AppError from './AppError.js';

class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed', details = null) {
    super(message, 401, 'AUTHENTICATION_ERROR', details);

    // Add WWW-Authenticate header information
    this.authHeader = 'Bearer';
  }

  /**
   * Create AuthenticationError for invalid credentials
   */
  static invalidCredentials() {
    return new AuthenticationError('Invalid username or password', {
      reason: 'invalid_credentials'
    });
  }

  /**
   * Create AuthenticationError for missing token
   */
  static missingToken() {
    return new AuthenticationError('Authorization token is required', { reason: 'missing_token' });
  }

  /**
   * Create AuthenticationError for invalid token
   */
  static invalidToken(reason = 'invalid') {
    const messages = {
      expired: 'Authorization token has expired',
      malformed: 'Authorization token is malformed',
      invalid: 'Authorization token is invalid',
      revoked: 'Authorization token has been revoked'
    };

    return new AuthenticationError(messages[reason] || messages.invalid, {
      reason: `token_${reason}`
    });
  }

  /**
   * Create AuthenticationError for account issues
   */
  static accountDisabled() {
    return new AuthenticationError('Account has been disabled', { reason: 'account_disabled' });
  }

  /**
   * Create AuthenticationError for session issues
   */
  static sessionExpired() {
    return new AuthenticationError('Session has expired, please login again', {
      reason: 'session_expired'
    });
  }

  /**
   * Create AuthenticationError for too many attempts
   */
  static tooManyAttempts(retryAfter = 300) {
    return new AuthenticationError('Too many authentication attempts, please try again later', {
      reason: 'rate_limited',
      retryAfter
    });
  }

  /**
   * Create AuthenticationError for password reset
   */
  static invalidResetToken() {
    return new AuthenticationError('Password reset token is invalid or has expired', {
      reason: 'invalid_reset_token'
    });
  }

  /**
   * Convert to structured response format
   */
  toJSON() {
    return {
      success: false,
      error: this.message,
      statusCode: this.statusCode,
      details: {
        code: this.code,
        requestId: this.requestId,
        timestamp: this.timestamp,
        type: 'authentication',
        authHeader: this.authHeader,
        ...(this.details && { additionalDetails: this.details }),
        ...(this.details?.retryAfter && {
          retryAfter: this.details.retryAfter
        }),
        ...(isDevelopment() && {
          stack: this.stack
        })
      }
    };
  }

  /**
   * Get authentication challenge header value
   */
  getAuthChallenge() {
    return this.authHeader;
  }
}

export default AuthenticationError;
