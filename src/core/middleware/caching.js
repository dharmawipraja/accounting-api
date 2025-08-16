/**
 * Caching Middleware
 * HTTP caching control utilities
 */

import { CACHE_DURATION } from '../../shared/constants/index.js';

/**
 * Cache control middleware
 * Sets appropriate cache headers based on duration and visibility
 * @param {number} maxAge - Cache duration in seconds
 * @param {'public'|'private'} visibility - Cache visibility
 * @returns {Function} Middleware function
 */
export function cacheControl(maxAge = CACHE_DURATION.SHORT, visibility = 'private') {
  return async (request, reply) => {
    reply.header('Cache-Control', `${visibility}, max-age=${maxAge}`);
  };
}

/**
 * No cache middleware
 * Prevents caching of sensitive data
 */
export async function noCache(request, reply) {
  reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  reply.header('Pragma', 'no-cache');
  reply.header('Expires', '0');
}

/**
 * ETag middleware
 * Generates ETags for responses to enable conditional requests
 * @param {Function} generateETag - Function to generate ETag value
 * @returns {Function} Middleware function
 */
export function etag(generateETag) {
  return async (request, reply) => {
    const etagValue = await generateETag(request);
    reply.header('ETag', `"${etagValue}"`);

    // Check if client has matching ETag
    const clientETag = request.headers['if-none-match'];
    if (clientETag === `"${etagValue}"`) {
      reply.status(304).send();
      return;
    }
  };
}

/**
 * Last-Modified middleware
 * Sets Last-Modified header and handles conditional requests
 * @param {Function} getLastModified - Function to get last modified date
 * @returns {Function} Middleware function
 */
export function lastModified(getLastModified) {
  return async (request, reply) => {
    const lastModifiedDate = await getLastModified(request);
    const lastModifiedString = lastModifiedDate.toUTCString();

    reply.header('Last-Modified', lastModifiedString);

    // Check if client has matching If-Modified-Since
    const ifModifiedSince = request.headers['if-modified-since'];
    if (ifModifiedSince === lastModifiedString) {
      reply.status(304).send();
      return;
    }
  };
}
