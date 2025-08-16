/**
 * Accounts Module Index
 * Combines both general and detail account functionality
 */

export * from './detail/index.js';
export * from './general/index.js';

// Re-export with prefixed names for clarity
export {
  AccountGeneralController,
  AccountGeneralService,
  accountGeneralRoutes
} from './general/index.js';

export {
  AccountDetailController,
  AccountDetailService,
  accountDetailRoutes
} from './detail/index.js';
