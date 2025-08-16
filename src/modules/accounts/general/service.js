/**
 * Account General Service
 * Business logic for general account operations
 */

import { ulid } from 'ulid';
import { formatMoneyForDb } from '../../../core/database/utils.js';

export class AccountGeneralService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Create a new general account
   * @param {Object} accountData - Account data
   * @param {string} createdBy - ID of user creating this account
   * @returns {Promise<Object>} Created account
   */
  async createAccount(accountData, createdBy) {
    // Check if account number already exists
    const existingAccount = await this.prisma.accountGeneral.findFirst({
      where: {
        accountNumber: accountData.accountNumber,
        deletedAt: null
      }
    });

    if (existingAccount) {
      throw new Error('Account number already exists');
    }

    // Format monetary amounts for database
    const formattedData = {
      ...accountData,
      amountCredit: formatMoneyForDb(accountData.amountCredit || 0),
      amountDebit: formatMoneyForDb(accountData.amountDebit || 0)
    };

    const newAccount = await this.prisma.accountGeneral.create({
      data: {
        id: ulid(),
        ...formattedData,
        accountType: 'GENERAL',
        createdBy,
        updatedBy: createdBy,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });

    return this.formatAccountResponse(newAccount);
  }

  /**
   * Get general accounts with pagination and filtering
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Accounts and pagination info
   */
  async getAccounts({ limit, skip, search, accountCategory, reportType, includeDeleted = false }) {
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
      ...(reportType && { reportType })
    };

    // Execute queries in parallel
    const [accounts, total] = await Promise.all([
      this.prisma.accountGeneral.findMany({
        where,
        skip,
        take: limit,
        orderBy: { accountNumber: 'asc' }
      }),
      this.prisma.accountGeneral.count({ where })
    ]);

    return {
      accounts: accounts.map(account => this.formatAccountResponse(account)),
      total
    };
  }

  /**
   * Get general account by ID
   * @param {string} accountId - Account ID
   * @param {boolean} includeDeleted - Include soft deleted records
   * @returns {Promise<Object|null>} Account data or null
   */
  async getAccountById(accountId, includeDeleted = false) {
    const where = {
      id: accountId,
      ...(!includeDeleted && { deletedAt: null })
    };

    const account = await this.prisma.accountGeneral.findFirst({
      where,
      include: {
        accountDetails: {
          where: includeDeleted ? {} : { deletedAt: null },
          orderBy: { accountNumber: 'asc' }
        }
      }
    });

    return account ? this.formatAccountResponse(account) : null;
  }

  /**
   * Update general account
   * @param {string} accountId - Account ID
   * @param {Object} updateData - Data to update
   * @param {string} updatedBy - ID of user making the update
   * @returns {Promise<Object>} Updated account
   */
  async updateAccount(accountId, updateData, updatedBy) {
    // Check if account exists and not deleted
    const existingAccount = await this.prisma.accountGeneral.findFirst({
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

    const updatedAccount = await this.prisma.accountGeneral.update({
      where: { id: accountId },
      data: {
        ...formattedData,
        updatedBy,
        updatedAt: new Date()
      }
    });

    return this.formatAccountResponse(updatedAccount);
  }

  /**
   * Soft delete general account
   * @param {string} accountId - Account ID
   * @param {string} deletedBy - ID of user performing deletion
   * @returns {Promise<Object>} Updated account
   */
  async deleteAccount(accountId, deletedBy) {
    // Check if account exists and not already deleted
    const existingAccount = await this.prisma.accountGeneral.findFirst({
      where: { id: accountId, deletedAt: null }
    });

    if (!existingAccount) {
      throw new Error('Account not found');
    }

    // Check if account has associated detail accounts
    const detailAccountsCount = await this.prisma.accountDetail.count({
      where: { accountGeneralId: accountId, deletedAt: null }
    });

    if (detailAccountsCount > 0) {
      throw new Error('Cannot delete account with associated detail accounts');
    }

    const deletedAccount = await this.prisma.accountGeneral.update({
      where: { id: accountId },
      data: {
        deletedBy,
        deletedAt: new Date(),
        updatedBy: deletedBy,
        updatedAt: new Date()
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
      accountType: 'GENERAL'
    };
  }
}
