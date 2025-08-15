import { ulid } from 'ulid';
import { accountDetailService } from '../services/accountDetailService.js';
import { formatMoneyForDb, roundMoney } from '../utils/index.js';

/**
 * Controller handlers for account detail endpoints.
 * Keeps routing definitions declarative and moves business logic here.
 */
export const accountsDetailController = {
  async create(request, reply) {
    const userId = request.user.id;
    const validatedData = {
      ...request.body,
      accountType: 'DETAIL',
      createdBy: userId,
      updatedBy: userId,
      updatedAt: new Date()
    };

    try {
      validatedData.amountCredit = roundMoney(validatedData.amountCredit);
      validatedData.amountDebit = roundMoney(validatedData.amountDebit);

      const existingAccount = await accountDetailService.findUnique(request.server.prisma, {
        accountNumber: validatedData.accountNumber
      });

      if (existingAccount) {
        return reply.status(409).send({
          success: false,
          message: 'Account number already exists'
        });
      }

      const generalAccount = await request.server.prisma.accountGeneral.findFirst({
        where: { id: validatedData.accountGeneralId }
      });

      if (!generalAccount) {
        return reply.status(400).send({
          success: false,
          message: 'Parent general account not found or has been deleted'
        });
      }

      const accountDetail = await accountDetailService.create(request.server.prisma, {
        id: ulid(),
        ...validatedData,
        amountCredit: formatMoneyForDb(validatedData.amountCredit),
        amountDebit: formatMoneyForDb(validatedData.amountDebit)
      });

      const result = await accountDetailService.findFirst(
        request.server.prisma,
        { id: accountDetail.id },
        {
          include: {
            accountGeneral: {
              select: {
                id: true,
                accountNumber: true,
                accountName: true
              }
            }
          }
        }
      );

      reply.status(201).send({
        success: true,
        message: 'Account detail created successfully',
        data: {
          ...result,
          amountCredit: roundMoney(result.amountCredit),
          amountDebit: roundMoney(result.amountDebit)
        }
      });
    } catch (error) {
      request.log.error('Account detail creation failed:', error);

      if (error.code === 'P2002') {
        return reply.status(409).send({
          success: false,
          message: 'Account number must be unique'
        });
      }

      throw error;
    }
  },

  async list(request, reply) {
    try {
      const { limit, skip } = request.getPagination();
      const {
        search,
        accountCategory,
        reportType,
        transactionType,
        accountGeneralId,
        includeDeleted
      } = request.query;

      const includeDeletedBool = !!includeDeleted;

      const where = {
        ...(accountCategory && { accountCategory }),
        ...(reportType && { reportType }),
        ...(transactionType && { transactionType }),
        ...(accountGeneralId && { accountGeneralId }),
        ...(search && {
          OR: [
            { accountNumber: { contains: search, mode: 'insensitive' } },
            { accountName: { contains: search, mode: 'insensitive' } }
          ]
        })
      };

      const total = await accountDetailService.count(
        request.server.prisma,
        where,
        includeDeletedBool
      );

      const accountDetails = await accountDetailService.findMany(
        request.server.prisma,
        {
          where,
          include: {
            accountGeneral: {
              select: {
                id: true,
                accountNumber: true,
                accountName: true
              }
            }
          },
          orderBy: [{ accountNumber: 'asc' }, { accountName: 'asc' }],
          skip,
          take: limit
        },
        includeDeletedBool
      );

      return reply.paginate(
        accountDetails.map(a => ({
          ...a,
          amountCredit: roundMoney(a.amountCredit),
          amountDebit: roundMoney(a.amountDebit)
        })),
        total
      );
    } catch (error) {
      request.log.error('Failed to retrieve account details:', error);
      throw error;
    }
  },

  async getById(request, reply) {
    try {
      const { id } = request.params;
      const { includeDeleted: includeDeletedBool, includeLedgers: includeLedgersBool } =
        request.query;

      const accountDetail = await accountDetailService.findFirst(
        request.server.prisma,
        { id },
        {
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
            },
            ...(includeLedgersBool && {
              ledgers: {
                select: {
                  id: true,
                  referenceNumber: true,
                  amount: true,
                  description: true,
                  ledgerType: true,
                  transactionType: true,
                  postingStatus: true,
                  ledgerDate: true,
                  createdAt: true
                },
                orderBy: { createdAt: 'desc' },
                take: 10
              }
            })
          }
        },
        includeDeletedBool
      );

      if (!accountDetail) {
        return reply.status(404).send({
          success: false,
          message: 'Account detail not found'
        });
      }

      reply.send({
        success: true,
        message: 'Account detail retrieved successfully',
        data: {
          ...accountDetail,
          amountCredit: roundMoney(accountDetail.amountCredit),
          amountDebit: roundMoney(accountDetail.amountDebit),
          ...(accountDetail.ledgers && {
            ledgers: accountDetail.ledgers.map(l => ({
              ...l,
              amount: roundMoney(l.amount)
            }))
          })
        }
      });
    } catch (error) {
      request.log.error('Failed to retrieve account detail:', error);
      throw error;
    }
  },

  async update(request, reply) {
    try {
      const userId = request.user.id;
      const { id } = request.params;
      const updateData = {
        ...request.body,
        updatedBy: userId,
        updatedAt: new Date()
      };

      if (typeof updateData.amountCredit === 'number') {
        updateData.amountCredit = roundMoney(updateData.amountCredit);
        updateData.amountCredit = formatMoneyForDb(updateData.amountCredit);
      }
      if (typeof updateData.amountDebit === 'number') {
        updateData.amountDebit = roundMoney(updateData.amountDebit);
        updateData.amountDebit = formatMoneyForDb(updateData.amountDebit);
      }

      const existingAccountDetail = await accountDetailService.findFirst(request.server.prisma, {
        id
      });

      if (!existingAccountDetail) {
        return reply.status(404).send({
          success: false,
          message: 'Account detail not found or has been deleted'
        });
      }

      const updatedAccountDetail = await accountDetailService.update(
        request.server.prisma,
        { id },
        updateData
      );

      const result = await accountDetailService.findFirst(
        request.server.prisma,
        { id },
        {
          include: {
            accountGeneral: {
              select: {
                id: true,
                accountNumber: true,
                accountName: true
              }
            }
          }
        }
      );

      reply.send({
        success: true,
        message: 'Account detail updated successfully',
        data: {
          ...result,
          amountCredit: roundMoney(result.amountCredit),
          amountDebit: roundMoney(result.amountDebit)
        }
      });
    } catch (error) {
      request.log.error('Account detail update failed:', error);

      if (error.code === 'P2025') {
        return reply.status(404).send({
          success: false,
          message: 'Account detail not found'
        });
      }

      throw error;
    }
  },

  async remove(request, reply) {
    try {
      const { id } = request.params;

      const existingAccountDetail = await accountDetailService.findFirst(request.server.prisma, {
        id
      });

      if (!existingAccountDetail) {
        return reply.status(404).send({
          success: false,
          message: 'Account detail not found or has already been deleted'
        });
      }

      const relatedLedgers = await request.server.prisma.ledger.findFirst({
        where: { accountDetailId: id }
      });

      if (relatedLedgers) {
        return reply.status(400).send({
          success: false,
          message:
            'Cannot delete account detail with existing ledger entries. Please delete or move the ledger entries first.'
        });
      }

      const deletedAccountDetail = await accountDetailService.update(
        request.server.prisma,
        { id },
        {
          accountNumber: `${existingAccountDetail.accountNumber}-DELETED-${ulid().slice(-6).toUpperCase()}`,
          deletedAt: new Date(),
          updatedBy: request.user.id,
          updatedAt: new Date()
        }
      );

      reply.send({
        success: true,
        message: 'Account detail deleted successfully',
        data: {
          id: deletedAccountDetail.id,
          accountNumber: deletedAccountDetail.accountNumber,
          accountName: deletedAccountDetail.accountName,
          deletedAt: deletedAccountDetail.deletedAt
        }
      });
    } catch (error) {
      request.log.error('Account detail deletion failed:', error);

      if (error.code === 'P2025') {
        return reply.status(404).send({
          success: false,
          message: 'Account detail not found'
        });
      }

      throw error;
    }
  }
};
