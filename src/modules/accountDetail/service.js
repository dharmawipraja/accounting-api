/**
 * Account Detail Service
 * Business logic for account detail operations
 */

import { businessErrors } from '../../core/errors/index.js';

export class AccountDetailService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Get all detail accounts with pagination
   */
  async getAllAccounts({
    page = 1,
    limit = 10,
    accountCategory,
    reportType,
    accountGeneralAccountNumber,
    search
  }) {
    const skip = (page - 1) * limit;

    const whereClause = {
      deletedAt: null,
      ...(accountCategory && { accountCategory }),
      ...(reportType && { reportType }),
      ...(accountGeneralAccountNumber && { accountGeneralAccountNumber }),
      ...(search && {
        OR: [
          { accountNumber: { contains: search, mode: 'insensitive' } },
          { accountName: { contains: search, mode: 'insensitive' } }
        ]
      })
    };

    const [accounts, total] = await Promise.all([
      this.prisma.accountDetail.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { accountNumber: 'asc' },
        include: {
          accountGeneral: {
            select: {
              id: true,
              accountNumber: true,
              accountName: true,
              accountCategory: true,
              reportType: true,
              transactionType: true
            }
          }
        }
      }),
      this.prisma.accountDetail.count({ where: whereClause })
    ]);

    return { accounts, total };
  }

  /**
   * Get detail account by account number
   */
  async getAccountByAccountNumber(accountNumber) {
    const account = await this.prisma.accountDetail.findFirst({
      where: {
        accountNumber,
        deletedAt: null
      },
      include: {
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true,
            reportType: true,
            transactionType: true,
            amountDebit: true,
            amountCredit: true
          }
        },
        ledgers: {
          where: { deletedAt: null },
          select: {
            id: true,
            referenceNumber: true,
            amount: true,
            description: true,
            ledgerDate: true,
            transactionType: true,
            postingStatus: true
          },
          orderBy: { ledgerDate: 'desc' },
          take: 10 // Limit to latest 10 ledger entries
        }
      }
    });

    return account;
  }

  /**
   * Create detail account
   */
  async createAccount(accountData, userId) {
    const { generateId } = await import('../../shared/utils/id.js');

    // Check if account number already exists
    const existingAccount = await this.prisma.accountDetail.findFirst({
      where: {
        accountNumber: accountData.accountNumber,
        deletedAt: null
      }
    });

    if (existingAccount) {
      throw businessErrors.accountExists();
    }

    // Check if general account exists
    const generalAccount = await this.prisma.accountGeneral.findFirst({
      where: {
        accountNumber: accountData.accountGeneralAccountNumber,
        deletedAt: null
      }
    });

    if (!generalAccount) {
      throw businessErrors.accountNotFound();
    }

    const account = await this.prisma.accountDetail.create({
      data: {
        id: generateId(),
        ...accountData,
        accountType: 'DETAIL',
        accumulationAmountCredit: accountData.initialAmountCredit || 0,
        accumulationAmountDebit: accountData.initialAmountDebit || 0,
        amountCredit: accountData.initialAmountCredit || 0,
        amountDebit: accountData.initialAmountDebit || 0,
        createdBy: userId,
        updatedBy: userId,
        updatedAt: new Date()
      },
      include: {
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
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
   * Update detail account
   */
  async updateAccount(accountNumber, updateData, userId) {
    // Check if account exists
    const existingAccount = await this.prisma.accountDetail.findFirst({
      where: {
        accountNumber,
        deletedAt: null
      }
    });

    if (!existingAccount) {
      throw businessErrors.accountNotFound();
    }

    // If updating account number, check if new number already exists
    if (updateData.accountNumber && updateData.accountNumber !== accountNumber) {
      const accountWithNewNumber = await this.prisma.accountDetail.findFirst({
        where: {
          accountNumber: updateData.accountNumber,
          deletedAt: null
        }
      });

      if (accountWithNewNumber) {
        throw businessErrors.accountExists();
      }
    }

    // If updating general account, check if it exists
    if (updateData.accountGeneralAccountNumber) {
      const generalAccount = await this.prisma.accountGeneral.findFirst({
        where: {
          accountNumber: updateData.accountGeneralAccountNumber,
          deletedAt: null
        }
      });

      if (!generalAccount) {
        throw businessErrors.accountNotFound();
      }
    }

    const updatedAccount = await this.prisma.accountDetail.update({
      where: { accountNumber },
      data: {
        ...updateData,
        updatedBy: userId,
        updatedAt: new Date()
      },
      include: {
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true,
            reportType: true,
            transactionType: true
          }
        }
      }
    });

    return updatedAccount;
  }

  /**
   * Delete detail account (soft delete)
   */
  async deleteAccount(accountNumber, userId) {
    // Check if account exists
    const existingAccount = await this.prisma.accountDetail.findFirst({
      where: {
        accountNumber,
        deletedAt: null
      },
      include: {
        ledgers: {
          where: { deletedAt: null }
        }
      }
    });

    if (!existingAccount) {
      throw businessErrors.accountNotFound();
    }

    // Check if account has ledger entries
    if (existingAccount.ledgers.length > 0) {
      throw businessErrors.cannotDeleteAccount('existing ledger entries');
    }

    const deletedAccount = await this.prisma.accountDetail.update({
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
