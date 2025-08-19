/**
 * Dependency Injection Container
 * Manages application dependencies and their lifecycle
 */

import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { AccountController } from '../../modules/accounts/controller.js';
import { AccountService } from '../../modules/accounts/service.js';
import { AuthController } from '../../modules/auth/controller.js';
import { AuthService } from '../../modules/auth/service.js';
import { LedgersController } from '../../modules/ledgers/controller.js';
import { LedgersService } from '../../modules/ledgers/service.js';
import { UsersController } from '../../modules/users/controller.js';
import { UsersService } from '../../modules/users/service.js';

class DIContainer {
  constructor() {
    this.dependencies = new Map();
    this.initialized = false;
  }

  /**
   * Initialize all dependencies
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    // Initialize Prisma
    const prisma = new PrismaClient({
      log: ['error', 'warn'],
      errorFormat: 'pretty'
    });

    // Test database connection
    await prisma.$connect();
    this.register('prisma', prisma);

    // Register services
    this.registerServices();

    // Register controllers
    this.registerControllers();

    this.initialized = true;
  }

  /**
   * Register a dependency
   */
  register(name, dependency) {
    this.dependencies.set(name, dependency);
  }

  /**
   * Get a dependency
   */
  get(name) {
    if (!this.dependencies.has(name)) {
      throw new Error(`Dependency '${name}' not found`);
    }
    return this.dependencies.get(name);
  }

  /**
   * Register all services
   */
  registerServices() {
    const prisma = this.get('prisma');

    // Auth service
    const authService = new AuthService(prisma, env.JWT_SECRET, env.JWT_EXPIRES_IN);
    this.register('authService', authService);

    // Users service
    const usersService = new UsersService(prisma);
    this.register('usersService', usersService);

    // Account service
    const accountService = new AccountService(prisma);
    this.register('accountService', accountService);

    // Ledgers service
    const ledgersService = new LedgersService(prisma);
    this.register('ledgersService', ledgersService);
  }

  /**
   * Register all controllers
   */
  registerControllers() {
    // Auth controller
    const authService = this.get('authService');
    const authController = new AuthController(authService);
    this.register('authController', authController);

    // Users controller
    const usersService = this.get('usersService');
    const usersController = new UsersController(usersService);
    this.register('usersController', usersController);

    // Account controller
    const accountService = this.get('accountService');
    const accountController = new AccountController(accountService);
    this.register('accountController', accountController);

    // Ledgers controller
    const ledgersService = this.get('ledgersService');
    const ledgersController = new LedgersController(ledgersService);
    this.register('ledgersController', ledgersController);
  }

  /**
   * Close all connections
   */
  async cleanup() {
    const prisma = this.get('prisma');
    if (prisma) {
      await prisma.$disconnect();
    }
  }

  /**
   * Check if container is initialized
   */
  isInitialized() {
    return this.initialized;
  }
}

// Export singleton instance
export const container = new DIContainer();
export default container;
