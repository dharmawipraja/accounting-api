/**
 * Account Service
 * Business logic for account operations
 */

export class AccountService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Get general accounts with pagination
   */
  async getGeneralAccounts({ page = 1, limit = 10, accountCategory }) {
    const skip = (page - 1) * limit;

    const whereClause = {
      deletedAt: null,
      ...(accountCategory && { accountCategory })
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
              accountName: true
            }
          }
        }
      }),
      this.prisma.accountGeneral.count({ where: whereClause })
    ]);

    return { accounts, total };
  }

  /**
   * Get general account by ID
   */
  async getGeneralAccountById(id) {
    const account = await this.prisma.accountGeneral.findFirst({
      where: {
        id,
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
            amountCredit: true
          }
        }
      }
    });

    return account;
  }

  /**
   * Create general account
   */
  async createGeneralAccount(accountData, userId) {
    const { ulid } = await import('ulid');

    const account = await this.prisma.accountGeneral.create({
      data: {
        id: ulid(),
        ...accountData,
        accountType: 'GENERAL',
        amountCredit: 0,
        amountDebit: 0,
        createdBy: userId,
        updatedBy: userId,
        updatedAt: new Date()
      }
    });

    return account;
  }

  /**
   * Get detail accounts with pagination
   */
  async getDetailAccounts({ page = 1, limit = 10, accountCategory, accountGeneralId }) {
    const skip = (page - 1) * limit;

    const whereClause = {
      deletedAt: null,
      ...(accountCategory && { accountCategory }),
      ...(accountGeneralId && { accountGeneralAccountNumber: accountGeneralId })
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
              accountName: true
            }
          }
        }
      }),
      this.prisma.accountDetail.count({ where: whereClause })
    ]);

    return { accounts, total };
  }
}
