/**
 * Enhanced Security HTTP Headers
 *
 * This module extends @fastify/helmet with additional security headers
 * and customizable security policies.
 */

import fastifyHelmet from '@fastify/helmet';

/**
 * Content Security Policy (CSP) configurations
 */
export const cspPolicies = {
  // Strict policy for production APIs
  strict: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      mediaSrc: ["'none'"],
      objectSrc: ["'none'"],
      childSrc: ["'none'"],
      frameSrc: ["'none'"],
      workerSrc: ["'none'"],
      manifestSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },

  // Relaxed policy for development with documentation
  development: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:', 'http:'],
      fontSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      childSrc: ["'self'"],
      frameSrc: ["'self'"],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },

  // API-only policy (minimal)
  apiOnly: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'none'"],
      imgSrc: ["'none'"],
      fontSrc: ["'none'"],
      connectSrc: ["'self'"],
      mediaSrc: ["'none'"],
      objectSrc: ["'none'"],
      childSrc: ["'none'"],
      frameSrc: ["'none'"],
      workerSrc: ["'none'"],
      manifestSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
};

/**
 * HSTS configurations
 */
export const hstsConfigs = {
  strict: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },

  moderate: {
    maxAge: 7776000, // 90 days
    includeSubDomains: true,
    preload: false
  },

  basic: {
    maxAge: 86400, // 1 day
    includeSubDomains: false,
    preload: false
  }
};

/**
 * Security headers configuration
 */
export const securityHeaders = {
  // Prevent MIME type sniffing
  xContentTypeOptions: 'nosniff',

  // Prevent XSS attacks
  xXssProtection: '1; mode=block',

  // Prevent clickjacking
  xFrameOptions: 'DENY',

  // Control referrer information
  referrerPolicy: 'strict-origin-when-cross-origin',

  // Permissions policy (formerly Feature Policy)
  permissionsPolicy: [
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'payment=()',
    'usb=()',
    'magnetometer=()',
    'accelerometer=()',
    'gyroscope=()'
  ].join(', '),

  // Cross-Origin policies
  crossOriginEmbedderPolicy: 'require-corp',
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-origin'
};

/**
 * Enhanced security headers plugin
 */
export async function securityHeadersPlugin(fastify, options = {}) {
  const {
    environment = 'production',
    enableCSP = true,
    enableHSTS = true,
    cspPolicy = 'strict',
    hstsConfig = 'strict',
    customHeaders = {},
    apiOnly = false
  } = options;

  // Configure helmet options
  const helmetOptions = {
    // Content Security Policy
    contentSecurityPolicy: enableCSP
      ? {
          ...(cspPolicies[apiOnly ? 'apiOnly' : cspPolicy] || cspPolicies.strict),
          reportOnly: environment === 'development'
        }
      : false,

    // HTTP Strict Transport Security
    hsts: enableHSTS
      ? {
          ...(hstsConfigs[hstsConfig] || hstsConfigs.strict)
        }
      : false,

    // Cross-Origin Embedder Policy
    crossOriginEmbedderPolicy: apiOnly
      ? false
      : {
          policy: securityHeaders.crossOriginEmbedderPolicy
        },

    // Cross-Origin Opener Policy
    crossOriginOpenerPolicy: {
      policy: securityHeaders.crossOriginOpenerPolicy
    },

    // Cross-Origin Resource Policy
    crossOriginResourcePolicy: {
      policy: securityHeaders.crossOriginResourcePolicy
    },

    // DNS Prefetch Control
    dnsPrefetchControl: {
      allow: false
    },

    // Expect Certificate Transparency
    expectCt:
      environment === 'production'
        ? {
            maxAge: 86400,
            enforce: true
          }
        : false,

    // Frameguard (X-Frame-Options)
    frameguard: {
      action: 'deny'
    },

    // Hide Powered-By header
    hidePoweredBy: true,

    // IE No Open
    ieNoOpen: true,

    // Don't sniff MIME types
    noSniff: true,

    // Origin Agent Cluster
    originAgentCluster: true,

    // Referrer Policy
    referrerPolicy: {
      policy: securityHeaders.referrerPolicy
    },

    // XSS Filter
    xssFilter: true
  };

  // Register helmet with configuration
  await fastify.register(fastifyHelmet, helmetOptions);

  // Add custom security headers
  fastify.addHook('onSend', async (request, reply) => {
    // Permissions Policy
    if (securityHeaders.permissionsPolicy) {
      reply.header('Permissions-Policy', securityHeaders.permissionsPolicy);
    }

    // Custom headers
    Object.entries(customHeaders).forEach(([header, value]) => {
      reply.header(header, value);
    });

    // API-specific headers
    if (apiOnly) {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');
    }

    // Security headers for different environments
    if (environment === 'development') {
      reply.header('X-Environment', 'development');
    }

    // Remove potentially revealing headers
    reply.removeHeader('X-Powered-By');
    reply.removeHeader('Server');
  });
}

/**
 * CSRF protection plugin (simple token-based)
 */
export async function csrfProtectionPlugin(fastify, options = {}) {
  const {
    enabled = true,
    excludePaths = ['/health', '/status', '/docs'],
    tokenHeader = 'x-csrf-token',
    cookieName = 'csrf-token'
  } = options;

  if (!enabled) {
    return;
  }

  // Generate CSRF token
  const generateToken = () => {
    return fastify.jwt.sign({ type: 'csrf', timestamp: Date.now() });
  };

  // Verify CSRF token
  const verifyToken = token => {
    try {
      const payload = fastify.jwt.verify(token);
      return payload.type === 'csrf' && Date.now() - payload.timestamp < 3600000; // 1 hour
    } catch {
      return false;
    }
  };

  // Add CSRF token to response
  fastify.addHook('onSend', async (request, _reply) => {
    if (request.method === 'GET' && !excludePaths.some(path => request.url.startsWith(path))) {
      const token = generateToken();
      _reply.setCookie(cookieName, token, {
        httpOnly: true,
        secure: fastify.config.isProduction,
        sameSite: 'strict'
      });
    }
  });

  // Verify CSRF token on state-changing requests
  fastify.addHook('preHandler', async (request, _reply) => {
    const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method);
    const isExcluded = excludePaths.some(path => request.url.startsWith(path));

    if (isStateChanging && !isExcluded) {
      const token = request.headers[tokenHeader] || request.cookies[cookieName];

      if (!token || !verifyToken(token)) {
        throw fastify.httpErrors.forbidden('Invalid CSRF token');
      }
    }
  });
}
