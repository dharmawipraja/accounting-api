import { ulid } from 'ulid';
import { accountGeneralService } from '../services/accountGeneralService.js';
import { formatMoneyForDb, roundMoney } from '../utils/index.js';

/**
 * Controller handlers for account general endpoints.
 * Keeps routing definitions declarative and moves business logic here.
 */
export const accountsGeneralController = {
  async create(request, reply) {
    try {
      const userId = request.user.id;
      const accountData = request.body;

      const roundedAccountData = {
        ...accountData,
        amountCredit: roundMoney(accountData.amountCredit),
        amountDebit: roundMoney(accountData.amountDebit)
      };

      const existingAccount = await request.server.prisma.accountGeneral.findUnique({
        where: { accountNumber: roundedAccountData.accountNumber }
      });

      if (existingAccount) {
        return reply.status(409).send({ success: false, message: 'Account number already exists' });
      }

      const newAccount = await accountGeneralService.create(request.server.prisma, {
        id: ulid(),
        ...roundedAccountData,
        amountCredit: formatMoneyForDb(roundedAccountData.amountCredit),
        amountDebit: formatMoneyForDb(roundedAccountData.amountDebit),
        accountType: 'GENERAL',
        createdBy: userId,
        updatedBy: userId,
        updatedAt: new Date()
      });

      return reply.status(201).send({
        success: true,
        message: 'Account general created successfully',
        data: {
          ...newAccount,
          amountCredit: roundMoney(newAccount.amountCredit),
          amountDebit: roundMoney(newAccount.amountDebit)
        }
      });
    } catch (error) {
      request.log.error('Error creating account general:', error);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  },

  async list(request, reply) {
    try {
      const { limit, skip } = request.getPagination();
      const { accountCategory, reportType, search } = request.query;

      const where = {
        ...(accountCategory && { accountCategory }),
        ...(reportType && { reportType }),
        ...(search && {
          OR: [
            { accountNumber: { contains: search, mode: 'insensitive' } },
            { accountName: { contains: search, mode: 'insensitive' } }
          ]
        })
      };

      const total = await accountGeneralService.count(request.server.prisma, where);

      const accounts = await accountGeneralService.findMany(request.server.prisma, {
        where,
        skip,
        take: limit,
        orderBy: { accountNumber: 'asc' },
        select: {
          id: true,
          accountNumber: true,
          accountName: true,
          accountCategory: true,
          accountType: true,
          reportType: true,
          transactionType: true,
          amountCredit: true,
          amountDebit: true,
          createdAt: true,
          updatedAt: true
        }
      });

      return reply.paginate(
        accounts.map(a => ({
          ...a,
          amountCredit: roundMoney(a.amountCredit),
          amountDebit: roundMoney(a.amountDebit)
        })),
        total
      );
    } catch (error) {
      request.log.error('Error retrieving account general list:', error);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  },

  async getById(request, reply) {
    try {
      const { id } = request.params;

      const account = await accountGeneralService.findFirst(
        request.server.prisma,
        { id },
        {
          include: { _count: { select: { accountsDetail: true, ledgers: true } } }
        }
      );

      if (!account) {
        return reply.status(404).send({ success: false, message: 'Account general not found' });
      }

      return reply.send({
        success: true,
        message: 'Account general details retrieved successfully',
        data: {
          ...account,
          amountCredit: roundMoney(account.amountCredit),
          amountDebit: roundMoney(account.amountDebit)
        }
      });
    } catch (error) {
      request.log.error('Error retrieving account general:', error);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  },

  async update(request, reply) {
    try {
      const { id } = request.params;
      const validatedBody = request.body;
      const userId = request.user.id;

      const updateData = {
        ...validatedBody,
        ...(typeof validatedBody.amountCredit === 'number' && {
          amountCredit: roundMoney(validatedBody.amountCredit)
        }),
        ...(typeof validatedBody.amountDebit === 'number' && {
          amountDebit: roundMoney(validatedBody.amountDebit)
        })
      };

      const existingAccount = await request.server.prisma.accountGeneral.findFirst({
        where: { id }
      });

      if (!existingAccount) {
        return reply.status(404).send({ success: false, message: 'Account general not found' });
      }

      const updatedAccount = await accountGeneralService.update(
        request.server.prisma,
        { id },
        {
          ...updateData,
          updatedBy: userId,
          updatedAt: new Date()
        }
      );

      return reply.send({
        success: true,
        message: 'Account general updated successfully',
        data: {
          ...updatedAccount,
          amountCredit: roundMoney(updatedAccount.amountCredit),
          amountDebit: roundMoney(updatedAccount.amountDebit)
        }
      });
    } catch (error) {
      request.log.error('Error updating account general:', error);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  },

  async remove(request, reply) {
    try {
      const { id } = request.params;

      const existingAccount = await request.server.prisma.accountGeneral.findFirst({
        where: { id },
        include: { _count: { select: { accountsDetail: true, ledgers: true } } }
      });

      if (!existingAccount) {
        return reply.status(404).send({ success: false, message: 'Account general not found' });
      }

      const hasAssociatedRecords =
        existingAccount._count.accountsDetail > 0 || existingAccount._count.ledgers > 0;

      if (hasAssociatedRecords) {
        return reply.status(409).send({
          success: false,
          message: 'Cannot delete account with associated records',
          details: `Account has ${existingAccount._count.accountsDetail} detail accounts and ${existingAccount._count.ledgers} ledger entries`
        });
      }

      await accountGeneralService.softDelete(
        request.server.prisma,
        { id },
        {
          accountNumber: `${existingAccount.accountNumber}-DELETED-${ulid().slice(-6).toUpperCase()}`,
          deletedAt: new Date()
        }
      );

      return reply.send({ success: true, message: 'Account general deleted successfully' });
    } catch (error) {
      request.log.error('Error deleting account general:', error);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  }
};
