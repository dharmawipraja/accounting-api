import { createSuccessResponse } from '../utils/index.js';

/**
 * Lightweight pagination plugin
 * - request.getPagination() -> { page, limit, skip }
 * - reply.paginate(data, total, extraMeta) -> sends standardized success response with pagination meta
 */
export default async function paginationPlugin(fastify, opts = {}) {
  const defaultLimit = Number(opts.defaultLimit ?? 20);
  const maxLimit = Number(opts.maxLimit ?? 100);

  fastify.decorateRequest('getPagination', function getPagination() {
    const query = this.query || {};
    let page = Number(query.page) || 1;
    let limit = Number(query.limit) || defaultLimit;

    if (Number.isNaN(page) || page < 1) page = 1;
    if (Number.isNaN(limit) || limit < 1) limit = defaultLimit;
    if (limit > maxLimit) limit = maxLimit;

    const skip = (page - 1) * limit;

    return { page, limit, skip };
  });

  fastify.decorateReply('paginate', function paginate(data, total, extraMeta = {}) {
    // Use request.getPagination() to compute meta
    const { page, limit } = this.request.getPagination();
    const totalPages = Math.ceil(total / limit) || 0;
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    const pagination = {
      page,
      limit,
      total,
      totalPages,
      hasNext,
      hasPrev,
      nextPage: hasNext ? page + 1 : null,
      prevPage: hasPrev ? page - 1 : null
    };

    const meta = {
      pagination,
      ...extraMeta
    };

    return this.send(createSuccessResponse(data, meta));
  });
}
