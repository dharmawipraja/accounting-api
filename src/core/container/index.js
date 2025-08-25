/**
 * Dependency Injection Container
 * Manages application dependencies and their lifecycle
 */

import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { AccountDetailController } from '../../modules/accountDetail/controller.js';
import { AccountDetailService } from '../../modules/accountDetail/service.js';
import { AccountGeneralController } from '../../modules/accountGeneral/controller.js';
import { AccountGeneralService } from '../../modules/accountGeneral/service.js';
import { AuthController } from '../../modules/auth/controller.js';
import { AuthService } from '../../modules/auth/service.js';
import { LedgersController } from '../../modules/ledgers/controller.js';
import { LedgersService } from '../../modules/ledgers/service.js';
import { PostingController } from '../../modules/posting/controller.js';
import { PostingService } from '../../modules/posting/service.js';
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

    // Account General service
    const accountGeneralService = new AccountGeneralService(prisma);
    this.register('accountGeneralService', accountGeneralService);

    // Account Detail service
    const accountDetailService = new AccountDetailService(prisma);
    this.register('accountDetailService', accountDetailService);

    // Ledgers service
    const ledgersService = new LedgersService(prisma);
    this.register('ledgersService', ledgersService);

    // Posting service
    const postingService = new PostingService(prisma);
    this.register('postingService', postingService);
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

    // Account General controller
    const accountGeneralService = this.get('accountGeneralService');
    const accountGeneralController = new AccountGeneralController(accountGeneralService);
    this.register('accountGeneralController', accountGeneralController);

    // Account Detail controller
    const accountDetailService = this.get('accountDetailService');
    const accountDetailController = new AccountDetailController(accountDetailService);
    this.register('accountDetailController', accountDetailController);

    // Ledgers controller
    const ledgersService = this.get('ledgersService');
    const ledgersController = new LedgersController(ledgersService);
    this.register('ledgersController', ledgersController);

    // Posting controller
    const postingService = this.get('postingService');
    const postingController = new PostingController(postingService);
    this.register('postingController', postingController);
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
