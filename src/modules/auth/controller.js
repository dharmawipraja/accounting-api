/**
 * Auth Controller
 * HTTP request handlers for authentication
 */

import { authErrors, errors } from '../../core/errors/index.js';
import logger from '../../core/logging/index.js';
import { createSuccessResponse } from '../../shared/utils/index.js';
import { t } from '../../shared/i18n/index.js';

export class AuthController {
  constructor(authService) {
    this.authService = authService;
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

      const response = createSuccessResponse(authResult, t('auth.loginSuccessful'));
      res.status(200).json(response);
    } catch (error) {
      logger.error({ error, username: request.body?.username }, 'Login failed');

      // Log failed login attempt

      if (error.message === t('auth.invalidCredentials')) {
        throw authErrors.invalidCredentials();
      }

      throw errors.internal(t('auth.authenticationFailed'));
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
      { message: t('auth.logoutSuccessful') },
      t('auth.pleaseRemoveTokenFromClient')
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
      const user = await this.authService.getUserProfile(request.user.userId);

      const response = createSuccessResponse(user, t('auth.profileRetrievedSuccessfully'));
      res.status(200).json(response);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      request.log.error({ error, userId: request.user?.userId }, 'Failed to get user profile');
      throw errors.internal('Failed to retrieve profile');
    }
  }

  /**
   * Refresh JWT token
   * @param {Object} request - Express request object
   * @param {Object} res - Express response object
   */
  async refreshToken(request, res) {
    try {
      const newToken = this.authService.generateToken({
        userId: request.user.userId,
        username: request.user.username,
        role: request.user.role
      });

      const response = createSuccessResponse(
        { token: newToken },
        t('auth.tokenRefreshedSuccessfully')
      );
      res.status(200).json(response);
    } catch (error) {
      request.log.error({ error, userId: request.user?.userId }, 'Failed to refresh token');
      throw errors.internal('Failed to refresh token');
    }
  }
}
