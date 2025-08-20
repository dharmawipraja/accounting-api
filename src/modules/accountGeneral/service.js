/**
 * Account General Service
 * Business logic for account general operations
 */

import { BusinessLogicError } from '../../core/errors/index.js';

export class AccountGeneralService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Get all general accounts with pagination
   */
  async getAllAccounts({ page = 1, limit = 10, accountCategory, reportType, search }) {
    const skip = (page - 1) * limit;

    const whereClause = {
      deletedAt: null,
      ...(accountCategory && { accountCategory }),
      ...(reportType && { reportType }),
      ...(search && {
        OR: [
          { accountNumber: { contains: search, mode: 'insensitive' } },
          { accountName: { contains: search, mode: 'insensitive' } }
        ]
      })
    };

    const [accounts, total] = await Promise.all([
      this.prisma.accountGeneral.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { accountNumber: 'asc' },
        include: {
          accountsDetail: {
            where: { deletedAt: null },
            select: {
              id: true,
              accountNumber: true,
              accountName: true,
              amountDebit: true,
              amountCredit: true
            }
          }
        }
      }),
      this.prisma.accountGeneral.count({ where: whereClause })
    ]);

    return { accounts, total };
  }

  /**
   * Get general account by account number
   */
  async getAccountByAccountNumber(accountNumber) {
    const account = await this.prisma.accountGeneral.findFirst({
      where: {
        accountNumber,
        deletedAt: null
      },
      include: {
        accountsDetail: {
          where: { deletedAt: null },
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            amountDebit: true,
            amountCredit: true,
            accountCategory: true,
            reportType: true,
            transactionType: true
          }
        }
      }
    });

    return account;
  }

  /**
   * Create general account
   */
  async createAccount(accountData, userId) {
    const { generateId } = await import('../../shared/utils/id.js');

    // Check if account number already exists
    const existingAccount = await this.prisma.accountGeneral.findFirst({
      where: {
        accountNumber: accountData.accountNumber,
        deletedAt: null
      }
    });

    if (existingAccount) {
      throw new BusinessLogicError('Account number already exists');
    }

    const account = await this.prisma.accountGeneral.create({
      data: {
        id: generateId(),
        ...accountData,
        accountType: 'GENERAL',
        accumulationAmountCredit: accountData.initialAmountCredit || 0,
        accumulationAmountDebit: accountData.initialAmountDebit || 0,
        amountCredit: accountData.initialAmountCredit || 0,
        amountDebit: accountData.initialAmountDebit || 0,
        createdBy: userId,
        updatedBy: userId,
        updatedAt: new Date()
      },
      include: {
        accountsDetail: {
          where: { deletedAt: null },
          select: {
            id: true,
            accountNumber: true,
            accountName: true
          }
        }
      }
    });

    return account;
  }

  /**
   * Update general account
   */
  async updateAccount(accountNumber, updateData, userId) {
    // Check if account exists
    const existingAccount = await this.prisma.accountGeneral.findFirst({
      where: {
        accountNumber,
        deletedAt: null
      }
    });

    if (!existingAccount) {
      throw new BusinessLogicError('Account not found');
    }

    // If updating account number, check if new number already exists
    if (updateData.accountNumber && updateData.accountNumber !== accountNumber) {
      const accountWithNewNumber = await this.prisma.accountGeneral.findFirst({
        where: {
          accountNumber: updateData.accountNumber,
          deletedAt: null
        }
      });

      if (accountWithNewNumber) {
        throw new BusinessLogicError('Account number already exists');
      }
    }

    const updatedAccount = await this.prisma.accountGeneral.update({
      where: { accountNumber },
      data: {
        ...updateData,
        updatedBy: userId,
        updatedAt: new Date()
      },
      include: {
        accountsDetail: {
          where: { deletedAt: null },
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            amountDebit: true,
            amountCredit: true
          }
        }
      }
    });

    return updatedAccount;
  }

  /**
   * Delete general account (soft delete)
   */
  async deleteAccount(accountNumber, userId) {
    // Check if account exists
    const existingAccount = await this.prisma.accountGeneral.findFirst({
      where: {
        accountNumber,
        deletedAt: null
      },
      include: {
        accountsDetail: {
          where: { deletedAt: null }
        },
        ledgers: {
          where: { deletedAt: null }
        }
      }
    });

    if (!existingAccount) {
      throw new BusinessLogicError('Account not found');
    }

    // Check if account has detail accounts or ledgers
    if (existingAccount.accountsDetail.length > 0) {
      throw new BusinessLogicError('Cannot delete account with existing detail accounts');
    }

    if (existingAccount.ledgers.length > 0) {
      throw new BusinessLogicError('Cannot delete account with existing ledger entries');
    }

    const deletedAccount = await this.prisma.accountGeneral.update({
      where: { accountNumber },
      data: {
        deletedAt: new Date(),
        updatedBy: userId,
        updatedAt: new Date()
      }
    });

    return deletedAccount;
  }
}
