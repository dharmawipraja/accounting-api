/**
 * Small caching helper utilities for setting Cache-Control headers per-route.
 * Provides a route preHandler factory `cacheControl` and a direct setter `setCacheHeader`.
 */

export const setCacheHeader = (reply, ttlSeconds = 300, privacy = 'public') => {
  if (!reply || typeof reply.header !== 'function') return;
  // ensure numeric TTL
  const ttl = Number(ttlSeconds) || 0;
  const directive = privacy === 'private' ? 'private' : 'public';
  reply.header('Cache-Control', `${directive}, max-age=${Math.max(0, Math.floor(ttl))}`);
};

// Returns a Fastify preHandler that sets Cache-Control header
export const cacheControl = (ttlSeconds = 300, privacy = 'public') => {
  return async (request, reply) => {
    try {
      setCacheHeader(reply, ttlSeconds, privacy);
    } catch {
      // noop - never throw in preHandler because of header setting
    }
  };
};

export default cacheControl;
