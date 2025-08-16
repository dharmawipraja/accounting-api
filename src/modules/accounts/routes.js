/**
 * Combined Accounts Routes
 * Registers both general and detail account routes
 */

import { accountDetailRoutes } from './detail/index.js';
import { accountGeneralRoutes } from './general/index.js';

export async function accountsRoutes(fastify) {
  // Register general account routes under /general
  await fastify.register(accountGeneralRoutes, { prefix: '/general' });

  // Register detail account routes under /detail
  await fastify.register(accountDetailRoutes, { prefix: '/detail' });
}
