/** Database utilities: query builders, helpers, and reporting */
import Decimal from 'decimal.js';
import _ from 'lodash';
import { ulid } from 'ulid';
import { toUtcFromLocal } from '../utils/date.js';
import { roundMoney, toDecimal } from '../utils/index.js';
import { prisma } from './database.js';
import config from './index.js';
const APP_TIMEZONE = config.appConfig?.timezone || 'Asia/Makassar';

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
  const parsedPage = _.clamp(_.toInteger(page) || 1, 1, Number.MAX_SAFE_INTEGER);
  const parsedLimit = _.clamp(_.toInteger(limit) || 10, 1, 100);
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
      try {
        // interpret startDate at local midnight in app timezone, then convert to UTC
        filter[field].gte = toUtcFromLocal(startDate, APP_TIMEZONE, { mode: 'startOfDay' });
      } catch {
        filter[field].gte = new Date(startDate);
      }
    }

    if (endDate) {
      try {
        // interpret endDate at local end of day in app timezone, then convert to UTC
        filter[field].lte = toUtcFromLocal(endDate, APP_TIMEZONE, { mode: 'endOfDay' });
      } catch {
        filter[field].lte = new Date(endDate);
      }
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
/**
 * Run a custom action against the raw (unextended) Prisma client.
 * Use this only when you explicitly need to bypass the soft-delete extension.
 * Example: prisma.withSoftDeleted(p => p.accountDetail.findMany({ where }))
 */
export const withSoftDeleted = async fn => {
  return await prisma.withSoftDeleted(fn);
};

export const countWithDeleted = async (model, args = {}) => {
  return await prisma.withSoftDeleted(p => p[model].count(args));
};

export const findWithDeleted = async (model, args = {}) => {
  return await prisma.withSoftDeleted(p => p[model].findMany(args));
};

export const recordExists = async (model, where, includeSoftDeleted = false) => {
  if (includeSoftDeleted) {
    const count = await countWithDeleted(model, { where });
    return count > 0;
  }

  const count = await prisma[model].count({ where });
  return count > 0;
};

/**
 * Get record by ID with soft delete check
 */
export const findById = async (model, id, includeSoftDeleted = false) => {
  if (includeSoftDeleted) {
    return await prisma.withSoftDeleted(p => p[model].findUnique({ where: { id } }));
  }

  return await prisma[model].findUnique({ where: { id } });
};

/**
 * Bulk operations helper
 */
export const bulkCreate = async (model, data, batchSize = 100) => {
  const results = [];
  for (const batch of _.chunk(data, batchSize)) {
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
    console.error('Raw query execution failed:', { query, params, error: error.message });
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
    const [sizeResult] = await prisma.$queryRaw`
      SELECT pg_size_pretty(pg_database_size(current_database())) as size
    `;
    const [connectionResult] = await prisma.$queryRaw`
      SELECT count(*) as active_connections, current_database() as database_name
      FROM pg_stat_activity WHERE state = 'active'
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

    if (!account) throw new Error(`Account with ID ${accountId} not found`);

    const creditDec = toDecimal(account.amountCredit);
    const debitDec = toDecimal(account.amountDebit);
    const balanceDec =
      account.transactionType === 'DEBIT' ? debitDec.minus(creditDec) : creditDec.minus(debitDec);

    return {
      ...account,
      amountCredit: roundMoney(account.amountCredit),
      amountDebit: roundMoney(account.amountDebit),
      currentBalance: Number(balanceDec.toFixed(2))
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
    ledgerDate = null
  } = entryData;

  const resolvedLedgerDate = ledgerDate
    ? typeof ledgerDate === 'string'
      ? toUtcFromLocal(ledgerDate, APP_TIMEZONE, { mode: 'exact' })
      : ledgerDate
    : new Date();

  return await prisma.ledger.create({
    data: {
      id: ulid(),
      referenceNumber,
      amount,
      description,
      accountDetailId,
      accountGeneralId,
      ledgerType,
      transactionType,
      ledgerDate: resolvedLedgerDate,
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
export const getTrialBalance = async (asOfDate = null) => {
  try {
    const resolvedAsOf = asOfDate
      ? typeof asOfDate === 'string'
        ? toUtcFromLocal(asOfDate, APP_TIMEZONE, { mode: 'exact' })
        : asOfDate
      : new Date();

    const accounts = await prisma.accountDetail.findMany({
      where: {
        deletedAt: null
      },
      include: {
        ledgers: {
          where: {
            ledgerDate: {
              lte: resolvedAsOf
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
      const debits = account.ledgers.filter(l => l.transactionType === 'DEBIT');
      const credits = account.ledgers.filter(l => l.transactionType === 'CREDIT');

      const totalDebitsDec = debits.reduce(
        (acc, l) => acc.plus(toDecimal(l.amount)),
        new Decimal(0)
      );
      const totalCreditsDec = credits.reduce(
        (acc, l) => acc.plus(toDecimal(l.amount)),
        new Decimal(0)
      );

      const totalDebits = Number(totalDebitsDec.toFixed(2));
      const totalCredits = Number(totalCreditsDec.toFixed(2));

      return {
        accountId: account.id,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        accountCategory: account.accountCategory,
        debitBalance: totalDebits,
        creditBalance: totalCredits,
        netBalance: Number(totalDebitsDec.minus(totalCreditsDec).toFixed(2))
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
