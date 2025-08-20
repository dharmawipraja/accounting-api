/**
 * Users Service
 * Business logic for user operations
 */

import bcrypt from 'bcrypt';
import { USER_STATUS } from '../../shared/constants/index.js';
import { generateId } from '../../shared/utils/id.js';

export class UsersService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Create a new user
   * @param {Object} userData - User data
   * @param {string} createdBy - ID of user creating this user
   * @returns {Promise<Object>} Created user
   */
  async createUser(userData, createdBy) {
    const { password, ...otherData } = userData;

    // Check if username already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { username: userData.username }
    });

    if (existingUser) {
      throw new Error('Username already exists');
    }

    // Hash password
    const hashedPassword = await this.hashPassword(password);

    // Create user
    const newUser = await this.prisma.user.create({
      data: {
        id: generateId(),
        ...otherData,
        password: hashedPassword,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        forceLogout: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return newUser;
  }

  /**
   * Get users with pagination and filtering
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Users and pagination info
   */
  async getUsers({ limit, skip, search, role, status }) {
    // Build where clause
    const where = {
      ...(search && {
        OR: [
          { username: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } }
        ]
      }),
      ...(role && { role }),
      ...(status && { status })
    };

    // Execute queries in parallel
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          name: true,
          role: true,
          status: true,
          forceLogout: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      this.prisma.user.count({ where })
    ]);

    return { users, total };
  }

  /**
   * Get user by ID
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} User data or null
   */
  async getUserById(userId) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        forceLogout: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true
      }
    });
  }

  /**
   * Update user
   * @param {string} userId - User ID
   * @param {Object} updateData - Data to update
   * @param {string} updatedBy - ID of user making the update
   * @returns {Promise<Object>} Updated user
   */
  async updateUser(userId, updateData, updatedBy) {
    const { password, ...otherData } = updateData;

    // If username is being updated, check for conflicts
    if (otherData.username) {
      const existingUser = await this.prisma.user.findFirst({
        where: {
          username: otherData.username,
          NOT: { id: userId }
        }
      });

      if (existingUser) {
        throw new Error('Username already exists');
      }
    }

    // Hash password if provided
    let hashedPassword;
    if (password) {
      hashedPassword = await this.hashPassword(password);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...otherData,
        ...(hashedPassword && { password: hashedPassword }),
        updatedBy,
        updatedAt: new Date()
      },
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

    return updatedUser;
  }

  /**
   * Soft delete user
   * @param {string} userId - User ID
   * @param {string} deletedBy - ID of user performing deletion
   * @returns {Promise<Object>} Updated user
   */
  async deleteUser(userId, deletedBy) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        status: USER_STATUS.INACTIVE,
        deletedBy,
        deletedAt: new Date(),
        updatedBy: deletedBy,
        updatedAt: new Date()
      },
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
  }

  /**
   * Change user password
   * @param {string} userId - User ID
   * @param {string} currentPassword - Current password
   * @param {string} newPassword - New password
   * @returns {Promise<void>}
   */
  async changePassword(userId, currentPassword, newPassword) {
    // Get user with password
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { password: true }
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      throw new Error('Current password is incorrect');
    }

    // Hash new password and update
    const hashedNewPassword = await this.hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedNewPassword,
        updatedBy: userId,
        updatedAt: new Date()
      }
    });
  }

  /**
   * Hash password
   * @param {string} password - Plain text password
   * @returns {Promise<string>} Hashed password
   */
  async hashPassword(password) {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
  }
}
