/**
 * Auth Service
 * Business logic for authentication operations
 */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { USER_STATUS } from '../../shared/constants/index.js';

export class AuthService {
  constructor(prisma, jwtSecret, jwtExpiresIn = '24h') {
    this.prisma = prisma;
    this.jwtSecret = jwtSecret;
    this.jwtExpiresIn = jwtExpiresIn;
  }

  /**
   * Authenticate user with username and password
   * @param {string} username
   * @param {string} password
   * @returns {Promise<Object>} User data and token
   */
  async authenticate(username, password) {
    // Find active user
    const user = await this.prisma.user.findFirst({
      where: {
        username,
        status: USER_STATUS.ACTIVE
      },
      select: {
        id: true,
        username: true,
        password: true,
        name: true,
        role: true
      }
    });

    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      throw new Error('Invalid credentials');
    }

    // Generate JWT token
    const token = this.generateToken({
      userId: user.id,
      username: user.username,
      role: user.role
    });

    // Remove password from response
    // eslint-disable-next-line no-unused-vars
    const { password: _, ...userWithoutPassword } = user;

    return {
      token,
      user: userWithoutPassword,
      expiresIn: this.jwtExpiresIn
    };
  }

  /**
   * Generate JWT token
   * @param {Object} payload
   * @returns {string} JWT token
   */
  generateToken(payload) {
    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn
    });
  }

  /**
   * Verify JWT token
   * @param {string} token
   * @returns {Object} Decoded payload
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch {
      throw new Error('Invalid token');
    }
  }

  /**
   * Hash password
   * @param {string} password
   * @returns {Promise<string>} Hashed password
   */
  async hashPassword(password) {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * Verify password against hash
   * @param {string} password
   * @param {string} hashedPassword
   * @returns {Promise<boolean>} Is valid password
   */
  async verifyPassword(password, hashedPassword) {
    return bcrypt.compare(password, hashedPassword);
  }

  /**
   * Get user profile by ID
   * @param {string} userId
   * @returns {Promise<Object>} User profile
   */
  async getUserProfile(userId) {
    const user = await this.prisma.user.findUnique({
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
      throw new Error('User not found');
    }

    return user;
  }
}
