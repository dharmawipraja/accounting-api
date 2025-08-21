# 🏦 Accounting API

A modern, production-ready Express.js API for comprehensive accounting operations built with clean architecture principles and enterprise-grade patterns.

## 🏗️ Architecture Overview

This API follows Express.js best practices with a clean, maintainable architecture designed for scalability and maintainability:

### Key Principles

- **Dependency Injection** - Centralized container for managing dependencies and lifecycle
- **Layered Architecture** - Clear separation: Routes → Controllers → Services → Data Layer
- **Modular Design** - Feature-based module organization for better maintainability
- **Clean Code** - Readable, testable, and extensible codebase
- **Input Validation** - Comprehensive validation with express-validator
- **Security First** - Built-in security measures and authentication

### 📁 Project Structure

```
src/
├── app/                    # Application bootstrap and configuration
│   ├── factory.js         # Application factory with DI container setup
│   ├── middleware/        # Middleware configuration
│   │   ├── index.js       # Middleware orchestration (CORS, security, logging)
│   │   └── errorHandling.js # Global error handling middleware
│   └── routes/           # Route registration
│       ├── index.js      # Central route registration with DI
│       └── health.js     # Health check endpoints (health, ready, live)
├── core/                  # Core utilities and infrastructure
│   ├── container/        # Dependency injection container
│   │   └── index.js      # DI container with lifecycle management
│   ├── database/         # Database utilities
│   │   └── utils.js      # Database helper functions
│   ├── errors/          # Comprehensive error handling
│   │   ├── AppError.js         # Base application error
│   │   ├── AuthenticationError.js
│   │   ├── AuthorizationError.js
│   │   ├── BusinessLogicError.js
│   │   ├── DatabaseError.js
│   │   ├── ValidationError.js
│   │   ├── errorHandler.js     # Error processing utilities
│   │   └── index.js           # Error exports
│   ├── logging/         # Structured logging with Pino
│   │   ├── index.js     # Logger exports
│   │   └── logger.js    # Pino logger configuration
│   ├── middleware/      # Core middleware
│   │   ├── auth.js      # JWT authentication & authorization
│   │   ├── pagination.js # Pagination helpers
│   │   ├── validation.js # Input validation middleware
│   │   └── index.js     # Middleware exports
│   └── security/        # Security utilities
│       ├── index.js     # Security exports
│       └── security.js  # Security validation helpers
├── modules/             # Feature modules (business logic)
│   ├── auth/           # Authentication & authorization
│   │   ├── controller.js # HTTP handlers for auth operations
│   │   ├── service.js   # Authentication business logic
│   │   └── routes.js    # Auth route definitions with validation
│   ├── users/          # User management
│   │   ├── controller.js # User CRUD operations
│   │   ├── service.js   # User business logic
│   │   └── routes.js    # User routes with role-based access
│   │   └── index.js     # Module exports
│   ├── accounts/       # Chart of accounts management
│   │   ├── controller.js # Account operations (general/detail)
│   │   ├── service.js   # Account business logic
│   │   ├── routes.js    # Account routes
│   │   └── index.js     # Module exports
│   └── ledgers/        # Double-entry ledger system
│       ├── controller.js # Ledger entry operations
│       ├── service.js   # Ledger business logic & validation
│       ├── routes.js    # Ledger routes with pagination
│       └── schemas.js   # Ledger validation schemas
├── shared/             # Shared utilities across modules
│   ├── constants/      # Application-wide constants
│   │   └── index.js    # HTTP status, pagination, validation limits
│   └── utils/          # Utility functions
│       ├── errors.js   # Error utility functions
│       ├── helpers.js  # General helper functions
│       ├── id.js       # ULID generation utilities
│       ├── response.js # Standardized API response helpers
│       └── index.js    # Utility exports
├── config/             # Configuration management
│   ├── index.js        # Main configuration with validation
│   └── env.js          # Environment variable handling
└── utils/              # Legacy utilities (being migrated)

prisma/                 # Database layer
├── schema.prisma       # Database schema with enums & relations
├── seed.js            # Database seeding with sample data
└── migrations/        # Database migration files
    ├── migration_lock.toml
    ├── 20250812155344_init_db/
    ├── 20250814041830_add_nanoid_for_ids/
    └── 20250819033817_change_foreign_key/
```

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ (LTS recommended)
- **PostgreSQL** 14+ database
- **npm** or **yarn** package manager

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd accounting-api

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
# Edit .env with your database credentials and JWT secrets

# Setup database
npm run prisma:migrate    # Apply database migrations
npm run prisma:seed      # Seed initial data (admin user & accounts)

# Generate Prisma client
npm run prisma:generate

# Start development server
npm run dev
```

### Environment Variables

Create a `.env` file with the following variables:

```env
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/accounting_db"

# JWT Configuration
JWT_SECRET="your-super-secret-jwt-key"
JWT_EXPIRES_IN="24h"

# Server Configuration
NODE_ENV="development"
PORT=3000
HOST="0.0.0.0"

# Logging
LOG_LEVEL="info"
```

### Available Scripts

```bash
# Development
npm run dev              # Start with nodemon (auto-reload)
npm start               # Production server

# Database
npm run prisma:migrate  # Run database migrations
npm run prisma:reset    # Reset database (development only)
npm run prisma:seed     # Seed initial data
npm run prisma:studio   # Open Prisma Studio GUI
npm run prisma:generate # Generate Prisma client
npm run prisma:format   # Format schema file
npm run prisma:prod     # Deploy migrations (production)

# Testing
npm test               # Run tests with Vitest
npm run test:ui        # Run tests with UI
npm run test:coverage  # Run with coverage report
npm run test:watch     # Run tests in watch mode

# Code Quality
npm run lint           # ESLint check
npm run lint:fix       # Fix ESLint issues
npm run format         # Format with Prettier
npm run format:check   # Check format
npm run format:lint    # Format and lint

# Production
npm run prod           # Start with PM2 cluster
npm run stop           # Stop PM2 processes
npm run restart        # Restart PM2 processes
npm run logs           # View PM2 logs
npm run monitor        # PM2 monitoring dashboard
```

## 📊 API Endpoints

### 🔐 Authentication

- `POST /api/v1/auth/login` - User login (returns JWT token)
- `POST /api/v1/auth/logout` - User logout (invalidates token)
- `GET /api/v1/auth/profile` - Get authenticated user profile
- `POST /api/v1/auth/refresh` - Refresh JWT token

### 👥 User Management

- `GET /api/v1/users` - List users with pagination (Admin only)
- `GET /api/v1/users/:id` - Get user by ID
- `POST /api/v1/users` - Create new user (Admin only)
- `PUT /api/v1/users/:id` - Update user information
- `DELETE /api/v1/users/:id` - Soft delete user (Admin only)
- `PATCH /api/v1/users/:id/status` - Update user status (Admin only)

### 💰 Account Management (Chart of Accounts)

**General Accounts (Top-level accounts)**

- `GET /api/v1/accounts/general` - List general accounts with pagination
- `GET /api/v1/accounts/general/:id` - Get general account details
- `POST /api/v1/accounts/general` - Create general account
- `PUT /api/v1/accounts/general/:id` - Update general account
- `DELETE /api/v1/accounts/general/:id` - Soft delete general account

**Detail Accounts (Sub-accounts)**

- `GET /api/v1/accounts/detail` - List detail accounts with pagination
- `GET /api/v1/accounts/detail/:id` - Get detail account details
- `POST /api/v1/accounts/detail` - Create detail account
- `PUT /api/v1/accounts/detail/:id` - Update detail account
- `DELETE /api/v1/accounts/detail/:id` - Soft delete detail account

### 📚 Ledger Management (Double-Entry Bookkeeping)

- `GET /api/v1/ledgers` - List ledger entries with pagination & filtering
- `GET /api/v1/ledgers/:id` - Get specific ledger entry
- `GET /api/v1/ledgers/by-date` - Get ledgers by date with totals (ADMIN, MANAJER, AKUNTAN only)
- `POST /api/v1/ledgers` - Create bulk ledger entries (auto-balancing)
- `PUT /api/v1/ledgers/:id` - Update ledger entry
- `DELETE /api/v1/ledgers/:id` - Soft delete ledger entry
- `POST /api/v1/ledgers/posting` - Post ledgers by date (ADMIN, MANAJER, AKUNTAN only)
- `POST /api/v1/ledgers/unposting` - Unpost ledgers by date (ADMIN, MANAJER, AKUNTAN only)

**Ledger Query Parameters:**

- `?search=` - Search in description or reference number
- `?referenceNumber=` - Filter by reference number
- `?ledgerType=` - Filter by ledger type (KAS_MASUK, KAS_KELUAR)
- `?transactionType=` - Filter by transaction type (DEBIT, CREDIT)
- `?postingStatus=` - Filter by posting status (PENDING, POSTED)
- `?startDate=` & `?endDate=` - Date range filtering
- `?accountDetailId=` - Filter by detail account
- `?accountGeneralId=` - Filter by general account
- `?includeAccounts=true` - Include account details in response

**Special Ledger Endpoints:**

**Get Ledgers by Date** - `POST /api/v1/ledgers/by-date`

```json
{
  "ledgerDate": "21-08-25"
}
```

Response includes totals and all ledger entries for the date:

```json
{
  "success": true,
  "message": "Ledgers retrieved successfully",
  "data": {
    "date": "21-08-25",
    "fullDate": "21-08-2025",
    "totalEntries": 10,
    "totalAmountCredit": 15000.00,
    "totalAmountDebit": 15000.00,
    "ledgers": [...]
  }
}
```

**Post Ledgers by Date** - `POST /api/v1/ledgers/posting`

```json
{
  "ledgerDate": "2025-08-21"
}
```

**Unpost Ledgers by Date** - `POST /api/v1/ledgers/unposting`

```json
{
  "ledgerDate": "2025-08-21"
}
```

Response includes:

```json
{
  "success": true,
  "message": "Ledgers unposted successfully",
  "data": {
    "unpostedCount": 10,
    "journalEntriesDeleted": 10,
    "unpostingTimestamp": "2025-08-21T...",
    "ledgers": [...]
  }
}
```

### ❤️ Health & Monitoring

- `GET /health` - Application health check (database connectivity)
- `GET /ready` - Readiness probe for container orchestration
- `GET /live` - Liveness probe for container orchestration
- `GET /api` - API information and available endpoints

## 📝 API Response Format

### Success Response

```json
{
  "success": true,
  "message": "Operation successful",
  "data": { ... }
}
```

### Error Response

```json
{
  "success": false,
  "error": "Error Type",
  "message": "Human readable message",
  "details": { ... }
}
```

### Paginated Response

```json
{
  "success": true,
  "message": "Data retrieved successfully",
  "data": [...],
  "pagination": {
    "page": 2,
    "limit": 10,
    "nextPage": 3,
    "prevPage": 1,
    "total": 100,
    "totalPages": 10,
    "hasNext": true,
    "hasPrev": false
  }
}
```

## 🔐 Authentication & Authorization

**JWT-based authentication** with comprehensive role-based access control (RBAC):

### User Roles & Permissions

- **ADMIN** - Full system access (all operations)
- **MANAJER** - Management operations (view all, limited modifications)
- **AKUNTAN** - Accounting operations (ledgers, accounts, reports)
- **KASIR** - Cashier operations (cash transactions, basic ledgers)
- **KOLEKTOR** - Collection operations (receivables, customer interactions)
- **NASABAH** - Customer operations (view own transactions only)

### Authentication Flow

1. **Login** - `POST /api/v1/auth/login` with username/password
2. **Token** - Receive JWT token with user role and permissions
3. **Authorization** - Include `Authorization: Bearer <token>` in requests
4. **Refresh** - Use refresh endpoint to extend token validity

### Security Features

- **Bcrypt** password hashing with salt rounds
- **JWT** tokens with configurable expiration
- **Role-based middleware** for endpoint protection
- **Input validation** on all authenticated routes
- **Password complexity** requirements (minimum 6 characters)

## 🛡️ Security Features

- **Helmet.js** - Comprehensive security headers (XSS, HSTS, etc.)
- **Rate Limiting** - Configurable request limiting to prevent abuse
- **CORS** - Cross-origin resource sharing with environment-specific settings
- **JWT Authentication** - Stateless authentication with secure signing
- **Input Validation** - Express-validator schema validation for all inputs
- **SQL Injection Prevention** - Prisma ORM with parameterized queries
- **Password Security** - Bcrypt hashing with configurable rounds
- **Request Sanitization** - Automatic input sanitization and validation
- **Error Information Hiding** - Production error messages don't leak internals
- **Secure Headers** - Content Security Policy, X-Frame-Options, etc.

## 📈 Performance Features

- **Response Compression** - Gzip/deflate compression for responses
- **Response Time Tracking** - Built-in performance monitoring
- **Database Connection Pooling** - Optimized Prisma connection management
- **Pagination** - Efficient data loading with cursor-based pagination
- **Selective Field Loading** - Prisma select for optimized queries
- **Error Boundaries** - Graceful error handling without crashes
- **Graceful Shutdown** - Clean application termination with connection cleanup
- **PM2 Cluster Mode** - Multi-process deployment for production scalability
- **ULID-based IDs** - Sortable, URL-safe unique identifiers

## 🏗️ Architecture Details

### Dependency Injection Container

The application uses a sophisticated DI container that manages all dependencies and their lifecycle:

```javascript
// Example: Getting a controller from container
const authController = container.get('authController');

// Controllers receive services via injection
export class AuthController {
  constructor(authService) {
    this.authService = authService;
  }

  async login(req, res) {
    const result = await this.authService.authenticate(req.body);
    // ...
  }
}
```

### Route Factory Pattern with DI

Routes are created using factory functions with full dependency injection:

```javascript
export function createAuthRoutes(container) {
  const router = Router();
  const authController = container.get('authController');

  router.post(
    '/login',
    validationMiddleware(loginSchema),
    asyncHandler(authController.login.bind(authController))
  );

  return router;
}
```

### Service Layer Architecture

Business logic is encapsulated in service classes with clear separation of concerns:

```javascript
export class AuthService {
  constructor(prisma, jwtSecret, jwtExpiresIn) {
    this.prisma = prisma;
    this.jwtSecret = jwtSecret;
    this.jwtExpiresIn = jwtExpiresIn;
  }

  async authenticate(credentials) {
    // Business logic: validation, encryption, token generation
    const user = await this.prisma.user.findFirst({ ... });
    const isValid = await bcrypt.compare(credentials.password, user.password);
    return this.generateToken(user);
  }
}
```

### Database Schema Design

**Double-Entry Bookkeeping System:**

- `AccountGeneral` - Top-level chart of accounts (Assets, Liabilities, etc.)
- `AccountDetail` - Sub-accounts linked to general accounts
- `Ledger` - Transaction entries with automatic balancing validation
- `User` - System users with role-based permissions

**Key Features:**

- ULID-based primary keys for better performance and sorting
- Foreign key relationships using account numbers (not IDs)
- Soft deletion support with `deletedAt` timestamps
- Comprehensive enums for account types, transaction types, and user roles
- Decimal precision for financial amounts (10,2)

### Error Handling Architecture

Comprehensive error handling with custom error classes:

```javascript
// Custom error hierarchy
class ValidationError extends AppError { ... }
class AuthenticationError extends AppError { ... }
class AuthorizationError extends AppError { ... }

// Global error handler
app.use((error, req, res, next) => {
  if (error instanceof ValidationError) {
    return res.status(400).json({ ... });
  }
  // ... handle other error types
});
```

## 🧪 Testing

The project uses **Vitest** as the testing framework with comprehensive coverage reporting:

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Interactive test UI
npm run test:ui

# Watch mode for development
npm run test:watch
```

### Test Configuration

- **Test Runner:** Vitest with Node.js environment
- **Coverage Provider:** V8 for accurate coverage reporting
- **Coverage Thresholds:** 80% minimum (branches, functions, lines, statements)
- **Test Location:** `tests/**/*.{test,spec}.js`
- **Timeouts:** 10 seconds for tests and hooks

### Testing with Dependency Injection

Tests leverage the DI container for easy mocking and isolation:

```javascript
// Example test with DI
describe('AuthController', () => {
  it('should authenticate valid user', async () => {
    const mockAuthService = {
      authenticate: vi.fn().mockResolvedValue({ token: 'jwt-token' })
    };

    const controller = new AuthController(mockAuthService);
    const result = await controller.login(mockReq, mockRes);

    expect(mockAuthService.authenticate).toHaveBeenCalled();
  });
});
```

## 📦 Production Deployment

### PM2 Cluster Deployment

```bash
# Build and deploy with PM2
npm run prod              # Start cluster mode

# PM2 Management
npm run stop              # Stop all processes
npm run restart           # Restart processes
npm run logs              # View application logs
npm run monitor           # PM2 monitoring dashboard
```

### PM2 Configuration (`ecosystem.config.json`)

- **Cluster Mode:** Automatic scaling across CPU cores
- **Memory Management:** Auto-restart at 1GB memory usage
- **Log Management:** Separate error, output, and combined logs
- **Graceful Shutdown:** 5-second graceful shutdown timeout
- **Auto-restart:** Max 10 restarts with delay for stability

### Environment Variables for Production

```env
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@host:5432/accounting_prod
JWT_SECRET=your-production-secret-key
JWT_EXPIRES_IN=24h
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=warn
```

### Database Migrations in Production

```bash
# Deploy migrations to production database
npm run prisma:prod

# Check migration status
npx prisma migrate status
```

### Container Deployment (Docker)

The application includes health checks suitable for container orchestration:

- **Health Check:** `GET /health` - Database connectivity
- **Readiness Probe:** `GET /ready` - Application ready to serve traffic
- **Liveness Probe:** `GET /live` - Application is running

### Performance Considerations

- Use database connection pooling (configured in Prisma)
- Enable response compression in production
- Configure appropriate log levels (`warn` or `error` for production)
- Use HTTPS in production environments
- Implement proper monitoring and alerting

## 🔍 Monitoring & Logging

### Structured Logging with Pino

- **JSON Format:** Structured logs for better parsing and analysis
- **Request Tracking:** Unique request IDs for tracing requests
- **Error Tracking:** Comprehensive error logging with stack traces
- **Performance Metrics:** Response time tracking and monitoring
- **Log Redaction:** Automatic redaction of sensitive data (passwords, tokens)

### Log Levels by Environment

- **Development:** Pretty-printed logs with colors and timestamps
- **Production:** JSON structured logs for log aggregation
- **Test:** Silent mode to avoid test noise

### Monitoring Endpoints

- **Health:** `GET /health` - Application and database health
- **Ready:** `GET /ready` - Kubernetes readiness probe
- **Live:** `GET /live` - Kubernetes liveness probe

### PM2 Monitoring

```bash
npm run monitor    # Real-time monitoring dashboard
npm run logs       # View application logs
```

## 💾 Database

### Schema Overview

The database follows **double-entry bookkeeping** principles:

**Core Tables:**

- `users` - System users with role-based access
- `accounts_general` - Chart of accounts (top-level)
- `accounts_detail` - Sub-accounts linked to general accounts
- `ledgers` - Transaction entries (debits/credits)
- `balances` - Account balance tracking

**Key Features:**

- **ULID Primary Keys** - Time-sortable, URL-safe identifiers
- **Soft Deletion** - Preserve data integrity with `deletedAt` fields
- **Decimal Precision** - Financial amounts with 10,2 precision
- **Foreign Key Constraints** - Data integrity through account number relationships
- **Comprehensive Enums** - Type safety for roles, account types, transaction types

### Migration History

1. `20250812155344_init_db` - Initial database schema
2. `20250814041830_add_nanoid_for_ids` - ULID implementation
3. `20250819033817_change_foreign_key` - Account number-based relationships

### Seeded Data

The database includes initial data:

- **Admin User:** `admin/admin123456`
- **Test Users:** Various roles (akuntan, manager, kasir, etc.)
- **Chart of Accounts:** Standard accounting structure (Assets, Liabilities, Equity, Revenue, Expenses)
- **Sample Transactions:** Demo ledger entries

## 🤝 Contributing

### Development Guidelines

1. **Follow established patterns** - Use existing architecture patterns
2. **Dependency injection** - Use the container for all new features
3. **Comprehensive testing** - Add tests for new functionality
4. **Code quality** - Follow ESLint + Prettier standards
5. **Documentation** - Update API docs for any changes
6. **Input validation** - Use express-validator for validation

### Code Style Standards

- **ES6+ Features** - Use modern JavaScript (modules, async/await, destructuring)
- **Dependency Injection** - Follow established DI patterns
- **Clean Code** - Write readable, self-documenting code
- **JSDoc Comments** - Document public methods and complex logic
- **Consistent Naming** - Follow established naming conventions
- **Error Handling** - Use custom error classes for different error types

### Development Workflow

```bash
# Setup development environment
npm install
npm run prisma:migrate
npm run prisma:seed

# Run in development mode
npm run dev

# Code quality checks
npm run lint
npm run format
npm run test

# Before committing
npm run format:lint    # Format and lint
npm run test           # Run all tests
```

### Adding New Features

1. **Create module** in `src/modules/[feature]/`
2. **Implement service** with business logic
3. **Create controller** with HTTP handlers
4. **Add routes** with express-validator validation
5. **Register in DI container**
6. **Add tests** for all components
7. **Update documentation**

### Git Commit Guidelines

- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Keep commits atomic and focused
- Write clear commit messages
- Test before committing

## �️ Tech Stack

### Core Technologies

- **Runtime:** Node.js 18+ with ES6 modules
- **Framework:** Express.js 4.19+ with modern middleware
- **Database:** PostgreSQL with Prisma ORM 6.13+
- **Authentication:** JWT with bcrypt password hashing
- **Validation:** Express-validator for input validation
- **Testing:** Vitest with V8 coverage provider
- **Logging:** Pino structured logging
- **Process Management:** PM2 for production clustering

### Key Dependencies

```json
{
  "dependencies": {
    "@prisma/client": "^6.13.0", // Database ORM
    "express": "^4.19.2", // Web framework
    "jsonwebtoken": "^9.0.2", // JWT authentication
    "bcrypt": "^6.0.0", // Password hashing
    "express-validator": "^7.2.0", // Input validation
    "pino": "^9.9.0", // Structured logging
    "helmet": "^7.1.0", // Security middleware
    "express-rate-limit": "^7.4.0", // Rate limiting
    "ulid": "^3.0.1", // Unique ID generation
    "decimal.js": "^10.5.0", // Precise decimal arithmetic
    "date-fns": "^4.1.0" // Date manipulation
  },
  "devDependencies": {
    "vitest": "^3.2.4", // Testing framework
    "eslint": "^9.33.0", // Code linting
    "prettier": "^3.6.2", // Code formatting
    "nodemon": "^3.1.10" // Development hot reload
  }
}
```

## �📚 Additional Resources

### Documentation & Guides

- **[Express.js Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)** - Security and performance
- **[Prisma Documentation](https://www.prisma.io/docs)** - Database ORM and migrations
- **[JWT.io](https://jwt.io/)** - JWT token standards and debugging
- **[Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)** - Comprehensive Node.js guide
- **[Express-validator Documentation](https://express-validator.github.io/)** - Input validation middleware

### Related Projects

- **[Pino Logger](https://getpino.io/)** - Fast JSON logger for Node.js
- **[PM2 Documentation](https://pm2.keymetrics.io/)** - Production process management
- **[Vitest](https://vitest.dev/)** - Next generation testing framework

### Accounting Standards

- **Double-Entry Bookkeeping** - Foundation accounting principles
- **Chart of Accounts** - Standard account classification
- **GAAP Compliance** - Generally Accepted Accounting Principles

## 📄 License

**ISC License** - See LICENSE file for details.

---

## 🚀 Quick Start Summary

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# Edit .env with your database URL and JWT secret

# 3. Setup database
npm run prisma:migrate
npm run prisma:seed

# 4. Start development
npm run dev

# 5. Open browser
# http://localhost:3000/health (health check)
# http://localhost:3000/api (API documentation)

# 6. Login with seeded admin user
# POST /api/v1/auth/login
# { "username": "admin", "password": "admin123456" }
```

Built with ❤️ using modern Node.js and Express.js patterns.
