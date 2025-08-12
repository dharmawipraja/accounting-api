/**
 * Database Utilities
 *
 * Common database operations, query builders, and helper functions
 * for the accounting API application.
 */

import { randomUUID } from 'crypto';
import { prisma } from './database.js';

/**
 * Database connection health check
 */
export const checkDatabaseHealth = async (prismaClient = prisma) => {
  try {
    // Simple query to check database connectivity
    await prismaClient.$queryRaw`SELECT 1`;
    return { healthy: true, timestamp: new Date().toISOString() };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * Pagination helper for database queries
 */
export const paginate = ({ page = 1, limit = 10 } = {}) => {
  const parsedPage = Math.max(1, parseInt(page) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit) || 10));
  const skip = (parsedPage - 1) * parsedLimit;

  return {
    take: parsedLimit,
    skip,
    page: parsedPage,
    limit: parsedLimit
  };
};

/**
 * Build pagination metadata
 */
export const buildPaginationMeta = (page, limit, total) => {
  const totalPages = Math.ceil(total / limit);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  return {
    page,
    limit,
    total,
    totalPages,
    hasNext,
    hasPrev,
    nextPage: hasNext ? page + 1 : null,
    prevPage: hasPrev ? page - 1 : null
  };
};

/**
 * Search and filter helper
 */
export const buildSearchFilter = (searchTerm, searchFields = []) => {
  if (!searchTerm || !searchFields.length) {
    return {};
  }

  return {
    OR: searchFields.map(field => ({
      [field]: {
        contains: searchTerm,
        mode: 'insensitive'
      }
    }))
  };
};

/**
 * Date range filter helper
 */
export const buildDateRangeFilter = (field, startDate, endDate) => {
  const filter = {};

  if (startDate || endDate) {
    filter[field] = {};

    if (startDate) {
      filter[field].gte = new Date(startDate);
    }

    if (endDate) {
      filter[field].lte = new Date(endDate);
    }
  }

  return filter;
};

/**
 * Soft delete helper
 */
export const softDelete = async (model, id, userId) => {
  return await prisma[model].update({
    where: { id },
    data: {
      deletedAt: new Date(),
      updatedBy: userId,
      updatedAt: new Date()
    }
  });
};

/**
 * Restore soft deleted record
 */
export const restoreSoftDeleted = async (model, id, userId) => {
  return await prisma[model].update({
    where: { id },
    data: {
      deletedAt: null,
      updatedBy: userId,
      updatedAt: new Date()
    }
  });
};

/**
 * Check if record exists and is not soft deleted
 */
export const recordExists = async (model, where, includeSoftDeleted = false) => {
  const filter = includeSoftDeleted ? where : { ...where, deletedAt: null };

  const count = await prisma[model].count({ where: filter });
  return count > 0;
};

/**
 * Get record by ID with soft delete check
 */
export const findById = async (model, id, includeSoftDeleted = false) => {
  const where = includeSoftDeleted ? { id } : { id, deletedAt: null };

  return await prisma[model].findUnique({ where });
};

/**
 * Bulk operations helper
 */
export const bulkCreate = async (model, data, batchSize = 100) => {
  const results = [];

  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const batchResult = await prisma[model].createMany({
      data: batch,
      skipDuplicates: true
    });
    results.push(batchResult);
  }

  return results;
};

/**
 * Execute raw SQL with proper error handling
 */
export const executeRawQuery = async (query, params = []) => {
  try {
    return await prisma.$queryRawUnsafe(query, ...params);
  } catch (error) {
    console.error('Raw query execution failed:', {
      query,
      params,
      error: error.message
    });
    throw error;
  }
};

/**
 * Database health check utilities
 */
export const getTableCounts = async () => {
  try {
    const [userCount, accountDetailCount, accountGeneralCount, ledgerCount, balanceCount] =
      await Promise.all([
        prisma.user.count(),
        prisma.accountDetail.count(),
        prisma.accountGeneral.count(),
        prisma.ledger.count(),
        prisma.balances.count()
      ]);

    return {
      users: userCount,
      accountsDetail: accountDetailCount,
      accountsGeneral: accountGeneralCount,
      ledgers: ledgerCount,
      balances: balanceCount,
      total: userCount + accountDetailCount + accountGeneralCount + ledgerCount + balanceCount
    };
  } catch (error) {
    console.error('Failed to get table counts:', error);
    throw error;
  }
};

/**
 * Database statistics
 */
export const getDatabaseStats = async () => {
  try {
    const tableCounts = await getTableCounts();

    // Get database size (PostgreSQL specific)
    const [sizeResult] = await prisma.$queryRaw`
      SELECT pg_size_pretty(pg_database_size(current_database())) as size
    `;

    // Get connection info
    const [connectionResult] = await prisma.$queryRaw`
      SELECT 
        count(*) as active_connections,
        current_database() as database_name
      FROM pg_stat_activity 
      WHERE state = 'active'
    `;

    return {
      tables: tableCounts,
      database: {
        size: sizeResult.size,
        name: connectionResult.database_name,
        activeConnections: parseInt(connectionResult.active_connections)
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Failed to get database statistics:', error);
    throw error;
  }
};

/**
 * Account-specific utilities
 */
export const getAccountBalance = async accountId => {
  try {
    const account = await prisma.accountDetail.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        accountName: true,
        amountCredit: true,
        amountDebit: true,
        accountCategory: true,
        transactionType: true
      }
    });

    if (!account) {
      throw new Error(`Account with ID ${accountId} not found`);
    }

    // Calculate current balance based on transaction type
    const balance =
      account.transactionType === 'DEBIT'
        ? account.amountDebit - account.amountCredit
        : account.amountCredit - account.amountDebit;

    return {
      ...account,
      currentBalance: balance
    };
  } catch (error) {
    console.error('Failed to get account balance:', error);
    throw error;
  }
};

/**
 * Ledger-specific utilities
 */
export const getAccountLedgerEntries = async (accountId, options = {}) => {
  const { page = 1, limit = 50, startDate, endDate } = options;
  const pagination = paginate({ page, limit });

  const where = {
    accountDetailId: accountId,
    deletedAt: null,
    ...(startDate || endDate ? buildDateRangeFilter('ledgerDate', startDate, endDate) : {})
  };

  const [entries, total] = await Promise.all([
    prisma.ledger.findMany({
      where,
      include: {
        accountDetail: {
          select: {
            accountName: true,
            accountNumber: true
          }
        }
      },
      orderBy: {
        ledgerDate: 'desc'
      },
      ...pagination
    }),
    prisma.ledger.count({ where })
  ]);

  const meta = buildPaginationMeta(pagination.page, pagination.limit, total);

  return {
    data: entries,
    meta
  };
};

/**
 * Transaction helpers
 */
export const createLedgerEntry = async (entryData, userId) => {
  const {
    accountDetailId,
    accountGeneralId,
    amount,
    description,
    ledgerType,
    transactionType,
    referenceNumber,
    ledgerDate = new Date()
  } = entryData;

  return await prisma.ledger.create({
    data: {
      id: randomUUID(),
      referenceNumber,
      amount,
      description,
      accountDetailId,
      accountGeneralId,
      ledgerType,
      transactionType,
      ledgerDate,
      createdBy: userId,
      updatedBy: userId,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });
};

/**
 * Reporting utilities
 */
export const getTrialBalance = async (asOfDate = new Date()) => {
  try {
    const accounts = await prisma.accountDetail.findMany({
      where: {
        deletedAt: null
      },
      include: {
        ledgers: {
          where: {
            ledgerDate: {
              lte: asOfDate
            },
            postingStatus: 'POSTED',
            deletedAt: null
          }
        }
      },
      orderBy: {
        accountNumber: 'asc'
      }
    });

    const trialBalance = accounts.map(account => {
      const totalDebits = account.ledgers
        .filter(l => l.transactionType === 'DEBIT')
        .reduce((sum, l) => sum + Number(l.amount), 0);

      const totalCredits = account.ledgers
        .filter(l => l.transactionType === 'CREDIT')
        .reduce((sum, l) => sum + Number(l.amount), 0);

      return {
        accountId: account.id,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        accountCategory: account.accountCategory,
        debitBalance: totalDebits,
        creditBalance: totalCredits,
        netBalance: totalDebits - totalCredits
      };
    });

    const totals = trialBalance.reduce(
      (acc, account) => {
        acc.totalDebits += account.debitBalance;
        acc.totalCredits += account.creditBalance;
        return acc;
      },
      { totalDebits: 0, totalCredits: 0 }
    );

    return {
      asOfDate,
      accounts: trialBalance,
      totals,
      isBalanced: Math.abs(totals.totalDebits - totals.totalCredits) < 0.01
    };
  } catch (error) {
    console.error('Failed to generate trial balance:', error);
    throw error;
  }
};

export default {
  checkDatabaseHealth,
  paginate,
  buildPaginationMeta,
  buildSearchFilter,
  buildDateRangeFilter,
  softDelete,
  restoreSoftDeleted,
  recordExists,
  findById,
  bulkCreate,
  executeRawQuery,
  getTableCounts,
  getDatabaseStats,
  getAccountBalance,
  getAccountLedgerEntries,
  createLedgerEntry,
  getTrialBalance
};
