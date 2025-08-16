/**
 * Business Logic Error Class
 *
 * Handles domain-specific business logic errors including
 * accounting rules, validation failures, and business constraints.
 */

import AppError from './AppError.js';

class BusinessLogicError extends AppError {
  constructor(message, details = null, statusCode = 400) {
    super(message, statusCode, 'BUSINESS_LOGIC_ERROR', details);
  }

  /**
   * Create BusinessLogicError for accounting balance issues
   */
  static balanceValidationFailed(accountId, currentBalance, attemptedAmount) {
    return new BusinessLogicError('Insufficient funds for this transaction', {
      reason: 'insufficient_balance',
      accountId,
      currentBalance,
      attemptedAmount,
      shortfall: attemptedAmount - currentBalance
    });
  }

  /**
   * Create BusinessLogicError for duplicate transactions
   */
  static duplicateTransaction(transactionId, existingTransactionId) {
    return new BusinessLogicError(
      'This transaction has already been processed',
      {
        reason: 'duplicate_transaction',
        transactionId,
        existingTransactionId
      },
      409
    );
  }

  /**
   * Create BusinessLogicError for closed accounting periods
   */
  static periodClosed(periodId, closedDate) {
    return new BusinessLogicError('Cannot modify transactions in a closed accounting period', {
      reason: 'period_closed',
      periodId,
      closedDate
    });
  }

  /**
   * Create BusinessLogicError for ledger balance issues
   */
  static ledgerImbalance(expectedBalance, actualBalance, variance) {
    return new BusinessLogicError('Ledger entries do not balance', {
      reason: 'ledger_imbalance',
      expectedBalance,
      actualBalance,
      variance
    });
  }

  /**
   * Create BusinessLogicError for invalid account operations
   */
  static invalidAccountOperation(accountId, operation, accountType) {
    return new BusinessLogicError(
      `Operation '${operation}' is not allowed for ${accountType} accounts`,
      {
        reason: 'invalid_account_operation',
        accountId,
        operation,
        accountType
      }
    );
  }

  /**
   * Create BusinessLogicError for date validation
   */
  static invalidTransactionDate(transactionDate, reason) {
    const messages = {
      future: 'Transaction date cannot be in the future',
      too_old: 'Transaction date is too far in the past',
      weekend: 'Transaction date cannot be on a weekend',
      holiday: 'Transaction date cannot be on a holiday'
    };

    return new BusinessLogicError(messages[reason] || 'Invalid transaction date', {
      reason: 'invalid_transaction_date',
      transactionDate,
      dateReason: reason
    });
  }

  /**
   * Create BusinessLogicError for workflow violations
   */
  static workflowViolation(currentStatus, attemptedStatus, allowedStatuses) {
    return new BusinessLogicError(
      `Cannot change status from '${currentStatus}' to '${attemptedStatus}'`,
      {
        reason: 'workflow_violation',
        currentStatus,
        attemptedStatus,
        allowedStatuses
      }
    );
  }

  /**
   * Create BusinessLogicError for limit violations
   */
  static limitExceeded(limitType, limit, attempted) {
    return new BusinessLogicError(`${limitType} limit exceeded`, {
      reason: 'limit_exceeded',
      limitType,
      limit,
      attempted,
      excess: attempted - limit
    });
  }

  /**
   * Create BusinessLogicError for dependency violations
   */
  static dependencyViolation(dependentResource, dependency) {
    return new BusinessLogicError('Cannot perform this action due to existing dependencies', {
      reason: 'dependency_violation',
      dependentResource,
      dependency
    });
  }

  /**
   * Create BusinessLogicError for state conflicts
   */
  static stateConflict(resourceType, resourceId, currentState, expectedState) {
    return new BusinessLogicError(
      `${resourceType} is in an unexpected state`,
      {
        reason: 'state_conflict',
        resourceType,
        resourceId,
        currentState,
        expectedState
      },
      409
    );
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
        type: 'business_logic',
        domain: this.getDomain()
      }
    };
  }

  /**
   * Determine the business domain of the error
   */
  getDomain() {
    const reason = this.details?.reason;

    if (['insufficient_balance', 'ledger_imbalance', 'period_closed'].includes(reason)) {
      return 'accounting';
    }

    if (['duplicate_transaction', 'invalid_transaction_date'].includes(reason)) {
      return 'transactions';
    }

    if (['workflow_violation', 'state_conflict'].includes(reason)) {
      return 'workflow';
    }

    return 'general';
  }
}

export default BusinessLogicError;
