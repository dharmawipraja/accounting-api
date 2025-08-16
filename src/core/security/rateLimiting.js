/**
 * Advanced Rate Limiting Strategies
 *
 * This module extends @fastify/rate-limit with custom strategies for different
 * types of endpoints and user behaviors.
 */

/**
 * Rate limiting strategies configuration
 */
const rateLimitStrategies = {
  // General API requests
  general: {
    max: 100,
    timeWindow: '1 minute',
    skipOnError: true
  },

  // Authentication endpoints (more restrictive)
  auth: {
    max: 5,
    timeWindow: '15 minutes',
    skipOnError: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false
  },

  // Per-user authenticated requests
  authenticated: {
    max: 1000,
    timeWindow: '1 hour',
    skipOnError: true
  },

  // Sensitive operations (create, update, delete)
  sensitive: {
    max: 10,
    timeWindow: '1 minute',
    skipOnError: false
  },

  // Heavy operations (reports, exports)
  heavy: {
    max: 3,
    timeWindow: '5 minutes',
    skipOnError: false
  }
};

/**
 * Custom key generator for user-based rate limiting
 */
const generateUserKey = request => {
  const userId = request.user?.id;
  const { ip } = request;

  if (userId) {
    return `user:${userId}`;
  }

  return `ip:${ip}`;
};

/**
 * Rate limiting plugin for authentication endpoints
 */
export async function authRateLimitPlugin(fastify) {
  await fastify.register(import('@fastify/rate-limit'), {
    ...rateLimitStrategies.auth,
    keyGenerator: request => `auth:${request.ip}`,
    errorResponseBuilder: (request, context) => {
      const retryAfter = Math.round(context.ttl / 1000);

      fastify.log.warn(
        {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          url: request.url,
          method: request.method,
          retryAfter
        },
        'Authentication rate limit exceeded'
      );

      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Too many authentication attempts. Retry in ${retryAfter} seconds.`,
        retryAfter
      };
    }
  });
}

/**
 * Rate limiting plugin for authenticated users
 */
export async function userRateLimitPlugin(fastify) {
  await fastify.register(import('@fastify/rate-limit'), {
    ...rateLimitStrategies.authenticated,
    keyGenerator: generateUserKey,
    errorResponseBuilder: (request, context) => {
      const retryAfter = Math.round(context.ttl / 1000);

      fastify.log.warn(
        {
          userId: request.user?.id,
          ip: request.ip,
          url: request.url,
          method: request.method,
          retryAfter
        },
        'User rate limit exceeded'
      );

      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Retry in ${retryAfter} seconds.`,
        retryAfter
      };
    }
  });
}

/**
 * Rate limiting plugin for sensitive operations
 */
export async function sensitiveRateLimitPlugin(fastify) {
  await fastify.register(import('@fastify/rate-limit'), {
    ...rateLimitStrategies.sensitive,
    keyGenerator: generateUserKey,
    errorResponseBuilder: (request, context) => {
      const retryAfter = Math.round(context.ttl / 1000);

      fastify.log.warn(
        {
          userId: request.user?.id,
          ip: request.ip,
          url: request.url,
          method: request.method,
          operation: 'sensitive',
          retryAfter
        },
        'Sensitive operation rate limit exceeded'
      );

      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Too many sensitive operations. Retry in ${retryAfter} seconds.`,
        retryAfter
      };
    }
  });
}

/**
 * Rate limiting plugin for heavy operations
 */
export async function heavyRateLimitPlugin(fastify) {
  await fastify.register(import('@fastify/rate-limit'), {
    ...rateLimitStrategies.heavy,
    keyGenerator: generateUserKey,
    errorResponseBuilder: (request, context) => {
      const retryAfter = Math.round(context.ttl / 1000);

      fastify.log.warn(
        {
          userId: request.user?.id,
          ip: request.ip,
          url: request.url,
          method: request.method,
          operation: 'heavy',
          retryAfter
        },
        'Heavy operation rate limit exceeded'
      );

      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Too many heavy operations. Retry in ${retryAfter} seconds.`,
        retryAfter
      };
    }
  });
}

/**
 * Create a custom rate limiter with specific options
 */
export function createCustomRateLimit(options = {}) {
  const defaultOptions = {
    max: 50,
    timeWindow: '1 minute',
    keyGenerator: generateUserKey,
    skipOnError: true,
    addHeadersOnExceeding: true,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true
    }
  };

  return async function customRateLimitPlugin(fastify) {
    await fastify.register(import('@fastify/rate-limit'), {
      ...defaultOptions,
      ...options
    });
  };
}

/**
 * Rate limiting decorator for route-specific limits
 */
export function withRateLimit(strategyName) {
  const strategy = rateLimitStrategies[strategyName];

  if (!strategy) {
    throw new Error(`Unknown rate limiting strategy: ${strategyName}`);
  }

  return {
    async preHandler(_request, _reply) {
      // This will be handled by the appropriate rate limiting plugin
      // registered for the specific route context
    }
  };
}
export { rateLimitStrategies };
