/**
 * Authorization Error Class
 *
 * Handles permission and authorization-related errors including
 * insufficient permissions, resource access control, and role-based errors.
 */

import AppError from './AppError.js';

class AuthorizationError extends AppError {
  constructor(message = 'Access denied', details = null) {
    super(message, 403, 'AUTHORIZATION_ERROR', details);
  }

  /**
   * Create AuthorizationError for insufficient permissions
   */
  static insufficientPermissions(requiredPermission = null) {
    return new AuthorizationError('You do not have permission to perform this action', {
      reason: 'insufficient_permissions',
      required: requiredPermission
    });
  }

  /**
   * Create AuthorizationError for resource access
   */
  static resourceAccessDenied(resourceType = null, resourceId = null) {
    return new AuthorizationError('You do not have permission to access this resource', {
      reason: 'resource_access_denied',
      resourceType,
      resourceId
    });
  }

  /**
   * Create AuthorizationError for role requirements
   */
  static roleRequired(requiredRole) {
    return new AuthorizationError(`This action requires ${requiredRole} role`, {
      reason: 'role_required',
      required: requiredRole
    });
  }

  /**
   * Create AuthorizationError for ownership requirements
   */
  static ownershipRequired(resourceType = 'resource') {
    return new AuthorizationError(`You can only access your own ${resourceType}`, {
      reason: 'ownership_required',
      resourceType
    });
  }

  /**
   * Create AuthorizationError for organization access
   */
  static organizationAccessDenied(organizationId = null) {
    return new AuthorizationError('You do not have access to this organization', {
      reason: 'organization_access_denied',
      organizationId
    });
  }

  /**
   * Create AuthorizationError for workspace access
   */
  static workspaceAccessDenied(workspaceId = null) {
    return new AuthorizationError('You do not have access to this workspace', {
      reason: 'workspace_access_denied',
      workspaceId
    });
  }

  /**
   * Create AuthorizationError for time-based restrictions
   */
  static timeRestricted(allowedTime = null) {
    return new AuthorizationError('This action is not allowed at this time', {
      reason: 'time_restricted',
      allowedTime
    });
  }

  /**
   * Create AuthorizationError for quota limits
   */
  static quotaExceeded(quotaType, limit, current) {
    return new AuthorizationError(`${quotaType} quota exceeded`, {
      reason: 'quota_exceeded',
      quotaType,
      limit,
      current
    });
  }

  /**
   * Create AuthorizationError for feature access
   */
  static featureNotAvailable(feature, plan = null) {
    return new AuthorizationError(`Feature '${feature}' is not available with your current plan`, {
      reason: 'feature_not_available',
      feature,
      requiredPlan: plan
    });
  }

  /**
   * Convert to structured response format
   */
  toJSON() {
    const baseResponse = super.toJSON();

    return {
      ...baseResponse,
      error: {
        ...baseResponse.error,
        type: 'authorization',
        canRetry: this.canRetry()
      }
    };
  }

  /**
   * Determine if the error might be resolved by retrying
   */
  canRetry() {
    const nonRetryableReasons = [
      'insufficient_permissions',
      'role_required',
      'ownership_required',
      'feature_not_available'
    ];

    return !nonRetryableReasons.includes(this.details?.reason);
  }
}

export default AuthorizationError;
