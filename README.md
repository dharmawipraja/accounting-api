# 🏦 Accounting API

A production-ready Express.js-based REST API for accounting operations with security, performance, and reliability best practices.

## ✨ Features

- 🚀 **High Performance**: Built with Express.js for reliability and ecosystem support
- 🔒 **Security First**: Security headers, CORS, rate limiting, and input validation
- 📊 **Production Ready**: Comprehensive logging, error handling, and health checks
- 🎯 **Type Safety**: Request/response schema validation
- 📈 **Scalable**: Designed for horizontal scaling and cloud deployment
- 🔄 **Graceful Shutdown**: Proper cleanup of resources and connections

## Tech Stack

- **Framework**: Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Validation**: JSON Schema
- **Logging**: Pino (structured logging)
- **Security**: Helmet, CORS, Rate Limiting
- **Performance**: Response compression, keep-alive connections

## Quick Start

### Prerequisites

- Node.js >= 16
- PostgreSQL database
- npm or yarn

### Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd accounting-api
```

2. Install dependencies:

```bash
npm install
```

3. Set up environment variables:

```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Set up the database:

```bash
# If using Prisma (recommended)
npx prisma migrate dev
npx prisma generate
```

5. Start the development server:

```bash
npm run dev
```

The API will be available at `http://localhost:3000`

## Environment Variables

| Variable          | Description                            | Default       |
| ----------------- | -------------------------------------- | ------------- |
| `PORT`            | Server port                            | `3000`        |
| `HOST`            | Server host                            | `0.0.0.0`     |
| `NODE_ENV`        | Environment                            | `development` |
| `LOG_LEVEL`       | Logging level                          | `info`        |
| `DATABASE_URL`    | PostgreSQL connection string           | Required      |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) | `*` in dev    |

## API Endpoints

### Health Check

- `GET /health` - Server health status

### API Root

- `GET /api` - API information

### Example Routes

- `GET /api/v1/users` - List users (with pagination)
- `GET /api/v1/users/:id` - Get user by ID
- `POST /api/v1/users` - Create new user

## Project Structure

```
├── server.js              # Main application entry point
├── src/
│   ├── routes/            # Route handlers
│   │   └── users.js       # Example user routes
│   ├── middleware/        # Custom middleware
│   │   ├── auth.js        # Authentication middleware
│   │   └── validation.js  # Request validation
│   └── utils/             # Utility functions
│       ├── response.js    # Response helpers
│       └── database.js    # Database utilities
├── .env                   # Environment variables
├── package.json          # Dependencies and scripts
└── README.md             # This file
```

## Development

### Available Scripts

```bash
# Development with auto-reload
npm run dev

# Production server
npm start

# Lint code
npm run lint
npm run lint:fix
```

### Adding New Routes

1. Create a new route file in `src/routes/`:

````javascript
```javascript
// Example Express route module
import express from 'express';

const router = express.Router();

router.get('/', async (req, res) => {
  res.json({ message: 'Hello World!' });
});

export default router;
````

### Register Routes

```javascript
// In your main app
import router from './src/routes/example.js';

app.use('/api', router);
```

2. Register the route in `src/router.js`:

```javascript
// Import and register the route
import exampleRouter from './src/routes/example.js';
app.use('/api/v1/example', exampleRouter);
```

## Security Features

### Implemented Security Measures

- **Helmet**: Security headers (CSP, HSTS, etc.)
- **CORS**: Configurable cross-origin resource sharing
- **Rate Limiting**: Prevents abuse and DoS attacks
- **Input Validation**: Schema-based request validation
- **Error Handling**: No information leakage in production
- **Request Logging**: Comprehensive audit trail

### Security Best Practices

1. **Environment Variables**: Never commit sensitive data
2. **HTTPS Only**: Use HTTPS in production
3. **Authentication**: Implement JWT or session-based auth
4. **Authorization**: Role-based access control
5. **Database Security**: Use prepared statements (Prisma handles this)
6. **Dependency Updates**: Regular security updates

## Performance Optimizations

- **Response Compression**: Gzip compression for responses > 1KB
- **Keep-Alive**: Persistent connections for better performance
- **Request Timeout**: Prevents hanging requests
- **Database Connection Pooling**: Efficient database connections
- **Schema Validation**: Fast JSON schema validation
- **Structured Logging**: High-performance logging with Pino

## Production Deployment

### Docker Deployment

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Environment Setup

```bash
# Production environment variables
NODE_ENV=production
PORT=3000
LOG_LEVEL=warn
DATABASE_URL=postgresql://...
ALLOWED_ORIGINS=https://yourdomain.com
```

### Health Monitoring

The API includes a health check endpoint at `/health` that returns:

```json
{
  "status": "ok",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "uptime": 3600,
  "version": "1.0.0"
}
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Run linting and tests
6. Submit a pull request

## License

ISC License - see LICENSE file for details

## Support

For questions and support, please open an issue on the GitHub repository.
