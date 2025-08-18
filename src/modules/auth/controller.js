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
   * @param {Object} res - Express response object
   */
  async login(request, res) {
    try {
      const { username, password } = request.body;

      const authResult = await this.authService.authenticate(username, password);

      // Log successful login

      const response = createSuccessResponse(authResult, 'Login successful');
      res.status(200).json(response);
    } catch (error) {
      console.error({ error, username: request.body?.username }, 'Login failed');

      // Log failed login attempt

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
   * @param {Object} res - Express response object
   */
  async logout(_request, res) {
    // Log logout event

    // For JWT, logout is typically handled client-side by removing the token
    // You could implement token blacklisting here if needed
    const response = createSuccessResponse(
      { message: 'Logout successful' },
      'Please remove the token from your client'
    );
    res.status(200).json(response);
  }

  /**
   * Get current user profile
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async getProfile(request, res) {
    try {
      const { userId } = request.user;

      const user = await request.app.locals.prisma.user.findUnique({
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
      res.status(200).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, userId: request.user?.userId }, 'Failed to get user profile');
      throw new AppError('Failed to retrieve profile', 500, 'PROFILE_RETRIEVAL_FAILED');
    }
  }
}
