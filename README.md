# 🏦 Accounting API

A modern, well-structured Express.js API for accounting operations using best practices and clean architecture.

## 🏗️ Architecture Overview

This API follows Express.js best practices with a clean, maintainable architecture:

### Key Principles

- **Dependency Injection** - Centralized container for managing dependencies
- **Layered Architecture** - Clear separation: Routes → Controllers → Services → Data
- **Modular Design** - Feature-based module organization
- **Clean Code** - Easy to read, maintain, and extend

### 📁 Project Structure

```
src/
├── app/                    # Application bootstrap and configuration
│   ├── factory.js         # Application factory (main entry point)
│   ├── middleware/        # Middleware configuration
│   │   ├── index.js       # Middleware orchestration
│   │   └── errorHandling.js
│   └── routes/           # Route registration
│       ├── index.js      # Central route registration
│       └── health.js     # Health check endpoints
├── core/                  # Core utilities and infrastructure
│   ├── container/        # Dependency injection container
│   │   └── index.js      # DI container implementation
│   ├── errors/          # Error classes and handlers
│   ├── logging/         # Logging configuration
│   ├── middleware/      # Core middleware (auth, validation)
│   └── security/        # Security utilities
├── modules/             # Feature modules (business logic)
│   ├── auth/           # Authentication & authorization
│   │   ├── controller.js
│   │   ├── service.js
│   │   ├── routes.js
│   │   └── index.js
│   ├── users/          # User management
│   │   ├── controller.js
│   │   ├── service.js
│   │   ├── routes.js
│   │   └── index.js
│   ├── accounts/       # Account management
│   │   ├── controller.js
│   │   ├── service.js
│   │   ├── routes.js
│   │   └── index.js
│   └── ledgers/        # Ledger management
│       ├── controller.js
│       ├── service.js
│       ├── routes.js
│       └── index.js
├── shared/             # Shared utilities
│   ├── constants/      # Application constants
│   ├── schemas/        # Validation schemas
│   └── utils/          # Utility functions
└── config/             # Configuration management
    ├── index.js        # Main configuration
    └── env.js          # Environment variables
```

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL
- npm or yarn

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd accounting-api

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
# Edit .env with your database credentials

# Setup database
npm run prisma:migrate
npm run prisma:seed

# Start development server
npm run dev
```

### Available Scripts

```bash
# Development
npm run dev              # Start with nodemon
npm start               # Production server

# Database
npm run prisma:migrate  # Run migrations
npm run prisma:reset    # Reset database
npm run prisma:seed     # Seed initial data
npm run prisma:studio   # Open Prisma Studio

# Testing
npm test               # Run tests
npm run test:coverage  # Run with coverage

# Code Quality
npm run lint           # ESLint check
npm run lint:fix       # Fix ESLint issues
npm run format         # Format with Prettier
```

## 📊 API Endpoints

### 🔐 Authentication

- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/logout` - User logout
- `GET /api/v1/auth/profile` - Get user profile
- `POST /api/v1/auth/refresh` - Refresh JWT token

### 👥 User Management

- `GET /api/v1/users` - List users (Admin only)
- `GET /api/v1/users/:id` - Get user by ID
- `POST /api/v1/users` - Create user (Admin only)
- `PUT /api/v1/users/:id` - Update user
- `DELETE /api/v1/users/:id` - Delete user (Admin only)

### 💰 Account Management

- `GET /api/v1/accounts/general` - List general accounts
- `GET /api/v1/accounts/general/:id` - Get general account
- `POST /api/v1/accounts/general` - Create general account
- `GET /api/v1/accounts/detail` - List detail accounts

### 📚 Ledger Management

- `GET /api/v1/ledgers` - List ledger entries
- `GET /api/v1/ledgers/:id` - Get ledger entry
- `POST /api/v1/ledgers` - Create bulk ledger entries
- `PUT /api/v1/ledgers/:id` - Update ledger entry
- `DELETE /api/v1/ledgers/:id` - Delete ledger entry

### ❤️ Health & Monitoring

- `GET /health` - Application health check
- `GET /ready` - Readiness probe (for containers)
- `GET /live` - Liveness probe (for containers)
- `GET /api` - API information and endpoints

## 🔐 Authentication & Authorization

JWT-based authentication with role-based access control:

- **ADMIN** - Full system access
- **MANAJER** - Management operations
- **AKUNTAN** - Accounting operations
- **KASIR** - Cashier operations
- **KOLEKTOR** - Collection operations
- **NASABAH** - Customer operations

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
    "page": 1,
    "limit": 10,
    "total": 100,
    "totalPages": 10,
    "hasNext": true,
    "hasPrev": false
  }
}
```

## 🛡️ Security Features

- **Helmet.js** - Security headers
- **Rate Limiting** - Prevent abuse
- **CORS** - Cross-origin resource sharing
- **JWT Authentication** - Stateless authentication
- **Input Validation** - Request validation middleware
- **SQL Injection Prevention** - Prisma ORM protection

## 📈 Performance Features

- **Compression** - Response compression
- **Response Time** - Request timing headers
- **Connection Pooling** - Database connection optimization
- **Error Boundaries** - Graceful error handling
- **Graceful Shutdown** - Clean application termination

## 🏗️ Architecture Details

### Dependency Injection

The application uses a centralized DI container that manages all dependencies:

```javascript
// Example: Getting a controller from container
const authController = container.get('authController');

// Controllers receive services via injection
class AuthController {
  constructor(authService) {
    this.authService = authService;
  }
}
```

### Route Factory Pattern

Routes are created using factory functions with dependency injection:

```javascript
export function createAuthRoutes(container) {
  const router = Router();
  const authController = container.get('authController');

  router.post('/login', authController.login.bind(authController));
  return router;
}
```

### Service Layer

Business logic is encapsulated in service classes:

```javascript
export class AuthService {
  constructor(prisma, jwtSecret) {
    this.prisma = prisma;
    this.jwtSecret = jwtSecret;
  }

  async authenticate(credentials) {
    // Business logic here
  }
}
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

Tests use dependency injection for easy mocking:

```javascript
// Example test with DI
const mockService = { authenticate: jest.fn() };
const controller = new AuthController(mockService);
```

## 📦 Production Deployment

```bash
# Build for production
npm run build

# Start with PM2
npm run prod

# Monitor with PM2
npm run monitor
```

### Environment Variables

Key environment variables:

```env
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h
PORT=3000
HOST=0.0.0.0
```

## 🔍 Monitoring & Logging

- **Structured Logging** - JSON formatted logs with Pino
- **Request Tracking** - Unique request IDs
- **Error Tracking** - Comprehensive error logging
- **Performance Metrics** - Response time tracking

## 🤝 Contributing

1. Follow the established patterns
2. Use dependency injection for new features
3. Add tests for new functionality
4. Follow coding standards (ESLint + Prettier)
5. Update documentation for API changes

### Code Style

- Use ES6+ features
- Follow dependency injection patterns
- Write clean, readable code
- Add JSDoc comments for public methods
- Use consistent naming conventions

## 📚 Additional Resources

- [Express.js Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [Prisma Documentation](https://www.prisma.io/docs)
- [JWT Authentication](https://jwt.io/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

## 📄 License

ISC License - see LICENSE file for details.
