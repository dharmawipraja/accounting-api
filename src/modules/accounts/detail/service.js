/**
 * Account Detail Service
 * Business logic for detailed account operations
 */

import { ulid } from 'ulid';
import { formatMoneyForDb } from '../../../core/database/utils.js';

export class AccountDetailService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Create a new detail account
   * @param {Object} accountData - Account data
   * @param {string} createdBy - ID of user creating this account
   * @returns {Promise<Object>} Created account
   */
  async createAccount(accountData, createdBy) {
    // Check if account number already exists
    const existingAccount = await this.prisma.accountDetail.findFirst({
      where: {
        accountNumber: accountData.accountNumber,
        deletedAt: null
      }
    });

    if (existingAccount) {
      throw new Error('Account number already exists');
    }

    // Verify that the general account exists
    const generalAccount = await this.prisma.accountGeneral.findFirst({
      where: {
        accountNumber: accountData.accountGeneralId, // accountGeneralId should contain account number
        deletedAt: null
      }
    });

    if (!generalAccount) {
      throw new Error('General account not found');
    }

    // Format monetary amounts for database
    const formattedData = {
      ...accountData,
      amountCredit: formatMoneyForDb(accountData.amountCredit || 0),
      amountDebit: formatMoneyForDb(accountData.amountDebit || 0),
      // Map accountGeneralId to the correct database field name
      accountGeneralAccountNumber: accountData.accountGeneralId
    };

    // Remove the old field name to avoid conflicts
    delete formattedData.accountGeneralId;

    const newAccount = await this.prisma.accountDetail.create({
      data: {
        id: ulid(),
        ...formattedData,
        accountType: 'DETAIL',
        createdBy,
        updatedBy: createdBy,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      include: {
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true
          }
        }
      }
    });

    return this.formatAccountResponse(newAccount);
  }

  /**
   * Get detail accounts with pagination and filtering
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Accounts and pagination info
   */
  async getAccounts({
    limit,
    skip,
    search,
    accountCategory,
    reportType,
    transactionType,
    accountGeneralId,
    includeDeleted = false,
    includeLedgers = false
  }) {
    // Build where clause
    const where = {
      ...(!includeDeleted && { deletedAt: null }),
      ...(search && {
        OR: [
          { accountNumber: { contains: search, mode: 'insensitive' } },
          { accountName: { contains: search, mode: 'insensitive' } }
        ]
      }),
      ...(accountCategory && { accountCategory }),
      ...(reportType && { reportType }),
      ...(transactionType && { transactionType }),
      ...(accountGeneralId && { accountGeneralAccountNumber: accountGeneralId })
    };

    // Build include clause
    const include = {
      accountGeneral: {
        select: {
          id: true,
          accountNumber: true,
          accountName: true
        }
      },
      ...(includeLedgers && {
        ledgers: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 10 // Limit recent ledgers
        }
      })
    };

    // Execute queries in parallel
    const [accounts, total] = await Promise.all([
      this.prisma.accountDetail.findMany({
        where,
        include,
        skip,
        take: limit,
        orderBy: { accountNumber: 'asc' }
      }),
      this.prisma.accountDetail.count({ where })
    ]);

    return {
      accounts: accounts.map(account => this.formatAccountResponse(account)),
      total
    };
  }

  /**
   * Get detail account by ID
   * @param {string} accountId - Account ID
   * @param {boolean} includeDeleted - Include soft deleted records
   * @param {boolean} includeLedgers - Include related ledger entries
   * @returns {Promise<Object|null>} Account data or null
   */
  async getAccountById(accountId, includeDeleted = false, includeLedgers = false) {
    const where = {
      id: accountId,
      ...(!includeDeleted && { deletedAt: null })
    };

    const include = {
      accountGeneral: {
        select: {
          id: true,
          accountNumber: true,
          accountName: true
        }
      },
      ...(includeLedgers && {
        ledgers: {
          where: includeDeleted ? {} : { deletedAt: null },
          orderBy: { ledgerDate: 'desc' }
        }
      })
    };

    const account = await this.prisma.accountDetail.findFirst({
      where,
      include
    });

    return account ? this.formatAccountResponse(account) : null;
  }

  /**
   * Update detail account
   * @param {string} accountId - Account ID
   * @param {Object} updateData - Data to update
   * @param {string} updatedBy - ID of user making the update
   * @returns {Promise<Object>} Updated account
   */
  async updateAccount(accountId, updateData, updatedBy) {
    // Check if account exists and not deleted
    const existingAccount = await this.prisma.accountDetail.findFirst({
      where: { id: accountId, deletedAt: null }
    });

    if (!existingAccount) {
      throw new Error('Account not found');
    }

    // Format monetary amounts if provided
    const formattedData = {
      ...updateData
    };

    if (updateData.amountCredit !== undefined) {
      formattedData.amountCredit = formatMoneyForDb(updateData.amountCredit);
    }
    if (updateData.amountDebit !== undefined) {
      formattedData.amountDebit = formatMoneyForDb(updateData.amountDebit);
    }

    const updatedAccount = await this.prisma.accountDetail.update({
      where: { id: accountId },
      data: {
        ...formattedData,
        updatedBy,
        updatedAt: new Date()
      },
      include: {
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true
          }
        }
      }
    });

    return this.formatAccountResponse(updatedAccount);
  }

  /**
   * Soft delete detail account
   * @param {string} accountId - Account ID
   * @param {string} deletedBy - ID of user performing deletion
   * @returns {Promise<Object>} Updated account
   */
  async deleteAccount(accountId, deletedBy) {
    // Check if account exists and not already deleted
    const existingAccount = await this.prisma.accountDetail.findFirst({
      where: { id: accountId, deletedAt: null }
    });

    if (!existingAccount) {
      throw new Error('Account not found');
    }

    // Check if account has associated ledger entries
    const ledgerEntriesCount = await this.prisma.ledger.count({
      where: { accountDetailAccountNumber: existingAccount.accountNumber, deletedAt: null }
    });

    if (ledgerEntriesCount > 0) {
      throw new Error('Cannot delete account with associated ledger entries');
    }

    const deletedAccount = await this.prisma.accountDetail.update({
      where: { id: accountId },
      data: {
        deletedBy,
        deletedAt: new Date(),
        updatedBy: deletedBy,
        updatedAt: new Date()
      },
      include: {
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true
          }
        }
      }
    });

    return this.formatAccountResponse(deletedAccount);
  }

  /**
   * Format account response to ensure consistent number formatting
   * @param {Object} account - Raw account data from database
   * @returns {Object} Formatted account data
   */
  formatAccountResponse(account) {
    return {
      ...account,
      amountCredit: parseFloat(account.amountCredit) || 0,
      amountDebit: parseFloat(account.amountDebit) || 0,
      accountType: 'DETAIL'
    };
  }
}
