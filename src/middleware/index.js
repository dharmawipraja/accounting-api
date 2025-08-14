export const requestIdPlugin = async fastify => {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });
};

export const timingPlugin = async fastify => {
  fastify.addHook('onRequest', async request => {
    request.startTime = Date.now();
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const responseTime = Date.now() - request.startTime;
    reply.header('x-response-time', `${responseTime}ms`);

    // Log slow queries
    if (responseTime > 1000) {
      request.log.warn(
        {
          url: request.url,
          method: request.method,
          responseTime: `${responseTime}ms`,
          statusCode: reply.statusCode
        },
        'Slow response detected'
      );
    }
  });
};

// Export validation middleware
export {
  safeParse,
  validate,
  validateBody,
  validateParams,
  validateQuery,
  validateResponse,
  default as validation,
  validationPreHandler
} from './validation.js';

// Export authentication middleware
export {
  authenticate,
  authorize,
  canManageUsers,
  checkNotDeleted,
  hashPassword,
  requireAdmin,
  requireAdminOrManager,
  requireOwnerOrAdmin,
  verifyPassword
} from './auth.js';
