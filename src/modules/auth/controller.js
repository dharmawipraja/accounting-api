/**
 * Auth Controller
 * HTTP request handlers for authentication
 */

import AppError from '../../core/errors/AppError.js';
import AuthenticationError from '../../core/errors/AuthenticationError.js';
import { createSuccessResponse } from '../../shared/utils/response.js';
import { AuthService } from './service.js';

export class AuthController {
  constructor(prisma, jwtSecret) {
    this.authService = new AuthService(prisma, jwtSecret);
  }

  /**
   * Handle login request
   * @param {Object} request - Express request object
   * @param {Object} reply - Express response object
   */
  async login(request, reply) {
    try {
      const { username, password } = request.body;

      const authResult = await this.authService.authenticate(username, password);

      // Log successful login
      if (request.server.securityAudit) {
        request.server.securityAudit.logLoginSuccess(
          authResult.user.id,
          authResult.user.username,
          request.ip,
          request.headers['user-agent'],
          request.id
        );
      }

      const response = createSuccessResponse(authResult, 'Login successful');
      reply.status(200).send(response);
    } catch (error) {
      request.log.error({ error, username: request.body?.username }, 'Login failed');

      // Debug logging
      console.log('Auth error caught:', {
        message: error.message,
        name: error.name,
        statusCode: error.statusCode,
        stack: error.stack?.split('\n')[0]
      });

      // Log failed login attempt
      if (request.server.securityAudit) {
        request.server.securityAudit.logLoginFailure(
          request.body?.username,
          request.ip,
          request.headers['user-agent'],
          error.message,
          request.id
        );
      }

      if (error.message === 'Invalid credentials') {
        const authError = new AuthenticationError('Invalid username or password');
        console.log('Throwing AuthenticationError:', authError.toJSON());
        throw authError;
      }

      const appError = new AppError('Authentication failed', 500, 'AUTH_FAILED');
      console.log('Throwing AppError:', appError.toJSON());
      throw appError;
    }
  }

  /**
   * Handle logout request (optional - mainly for client-side token removal)
   * @param {Object} request - Express request object
   * @param {Object} reply - Express response object
   */
  async logout(request, reply) {
    // Log logout event
    if (request.server.securityAudit && request.user) {
      request.server.securityAudit.logEvent({
        eventType: 'logout',
        riskLevel: 'low',
        timestamp: new Date(),
        userId: request.user.userId,
        userEmail: request.user.username,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        action: 'logout',
        success: true,
        requestId: request.id
      });
    }

    // For JWT, logout is typically handled client-side by removing the token
    // You could implement token blacklisting here if needed
    const response = createSuccessResponse(
      { message: 'Logout successful' },
      'Please remove the token from your client'
    );
    reply.status(200).send(response);
  }

  /**
   * Get current user profile
   * @param {Object} request - Express request object
   * @param {Object} reply - Express response object
   */
  async getProfile(request, reply) {
    try {
      const { userId } = request.user;

      const user = await request.server.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          name: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true
        }
      });

      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const response = createSuccessResponse(user);
      reply.status(200).send(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, userId: request.user?.userId }, 'Failed to get user profile');
      throw new AppError('Failed to retrieve profile', 500, 'PROFILE_RETRIEVAL_FAILED');
    }
  }
}
