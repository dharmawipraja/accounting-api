/**
 * accountDetailService
 * Encapsulates all Prisma DB operations for accountDetail entities.
 * Keeps DB access centralized so controllers and routes remain thin.
 */
export const accountDetailService = {
  async create(prisma, data) {
    return prisma.accountDetail.create({ data });
  },

  async count(prisma, where, includeDeleted = false) {
    return includeDeleted
      ? prisma.withSoftDeleted(p => p.accountDetail.count({ where }))
      : prisma.accountDetail.count({ where });
  },

  async findMany(prisma, opts, includeDeleted = false) {
    // opts: { where, skip, take, orderBy, select, include }
    return includeDeleted
      ? prisma.withSoftDeleted(p => p.accountDetail.findMany(opts))
      : prisma.accountDetail.findMany(opts);
  },

  async findFirst(prisma, where, include = undefined, includeDeleted = false) {
    return includeDeleted
      ? prisma.withSoftDeleted(p => p.accountDetail.findFirst({ where, include }))
      : prisma.accountDetail.findFirst({ where, include });
  },

  async findUnique(prisma, where) {
    return prisma.accountDetail.findUnique({ where });
  },

  async update(prisma, where, data) {
    return prisma.accountDetail.update({ where, data });
  }
};
