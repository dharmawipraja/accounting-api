# Codebase Structure

This document outlines the enhanced modular architecture implemented for better separation of concerns, maintainability, and scalability.

## Directory Structure

```
src/
├── app.js                         # Main application setup (existing)
├── router.js                      # Central routing configuration (NEW)
├── core/                          # Core application infrastructure (NEW)
│   ├── database/
│   │   └── utils.js               # Database utilities and helpers
│   └── middleware/
│       ├── auth.js                # Authentication & authorization middleware
│       ├── caching.js             # HTTP caching middleware
│       └── index.js               # Middleware exports
├── modules/                       # Feature-based modules (NEW)
│   ├── auth/                      # Authentication module
│   │   ├── controller.js          # Auth request handlers
│   │   ├── service.js             # Auth business logic
│   │   ├── routes.js              # Auth route definitions
│   │   ├── schemas.js             # Auth validation schemas
│   │   └── index.js               # Module exports
│   ├── users/                     # User management module
│   │   ├── controller.js          # User request handlers
│   │   ├── service.js             # User business logic
│   │   ├── routes.js              # User route definitions
│   │   ├── schemas.js             # User validation schemas
│   │   └── index.js               # Module exports
│   ├── health/                    # Health monitoring module
│   │   ├── controller.js          # Health check handlers
│   │   ├── service.js             # Health check logic
│   │   ├── routes.js              # Health route definitions
│   │   └── index.js               # Module exports
│   ├── accounts/                  # Account management (TODO)
│   └── ledgers/                   # Ledger management (TODO)
├── shared/                        # Shared utilities and resources (NEW)
│   ├── constants/
│   │   └── index.js               # Application constants
│   ├── schemas/
│   │   └── base.js                # Base validation schemas
│   ├── types/
│   │   └── index.js               # TypeScript-like type definitions
│   └── utils/
│       ├── response.js            # Response formatting utilities
│       └── index.js               # Utility exports
└── config/                        # Configuration (existing)
    ├── database.js
    ├── db-utils.js
    └── index.js
```

## Key Improvements

### 1. **Modular Architecture**

- **Feature-based modules**: Each business domain (auth, users, accounts, ledgers) is a self-contained module
- **Consistent structure**: Each module follows the same pattern (controller, service, routes, schemas)
- **Clear boundaries**: Business logic is separated from HTTP concerns and data access

### 2. **Separation of Concerns**

- **Controllers**: Handle HTTP requests/responses and input validation
- **Services**: Contain business logic and coordinate data operations
- **Routes**: Define API endpoints and OpenAPI schemas
- **Schemas**: Validation and type definitions using Zod

### 3. **Core Infrastructure**

- **Core middleware**: Centralized authentication, authorization, and caching logic
- **Database utilities**: Common database operations and health checks
- **Shared resources**: Constants, types, and utilities used across modules

### 4. **Better Organization**

- **Constants centralization**: All application constants in one place
- **Type definitions**: JSDoc-based type definitions for better IDE support
- **Consistent error handling**: Standardized error responses and status codes
- **Response utilities**: Consistent API response formatting

## Module Structure Pattern

Each module follows this consistent pattern:

```javascript
// schemas.js - Validation schemas
export const EntityCreateSchema = z.object({...});
export const EntityUpdateSchema = z.object({...});
export const EntityResponseSchema = z.object({...});

// service.js - Business logic
export class EntityService {
  async createEntity(data) { /* business logic */ }
  async getEntity(id) { /* business logic */ }
  async updateEntity(id, data) { /* business logic */ }
  async deleteEntity(id) { /* business logic */ }
}

// controller.js - HTTP handlers
export class EntityController {
  async create(request, reply) { /* handle HTTP request */ }
  async getById(request, reply) { /* handle HTTP request */ }
  async update(request, reply) { /* handle HTTP request */ }
  async delete(request, reply) { /* handle HTTP request */ }
}

// routes.js - Route definitions
export async function entityRoutes(fastify) {
  // Route definitions with schemas and middleware
}

// index.js - Module exports
export * from './service.js';
export * from './controller.js';
export * from './routes.js';
export * from './schemas.js';
```

## Benefits

### 1. **Maintainability**

- Clear separation between different concerns
- Easy to locate and modify specific functionality
- Consistent patterns across all modules

### 2. **Scalability**

- New features can be added as self-contained modules
- Easy to split modules into separate services if needed
- Clear dependencies and interfaces

### 3. **Testability**

- Services can be unit tested independently
- Controllers can be tested with mocked services
- Clear boundaries make mocking easier

### 4. **Code Reusability**

- Shared utilities and constants reduce duplication
- Common patterns can be extracted and reused
- Base schemas provide consistent validation

## Conclusion

This improved structure provides:

- **Better organization** through feature-based modules
- **Clear separation** of concerns and responsibilities
- **Consistent patterns** that are easy to follow and extend
- **Improved maintainability** and testability
- **Scalable architecture** that can grow with your application

The modular approach makes it easier to understand, maintain, and extend your codebase while following best practices for Node.js/Fastify applications.
