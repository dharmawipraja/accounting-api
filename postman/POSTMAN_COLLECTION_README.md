# Accounting API - Postman Collection

This repository contains a comprehensive Postman collection for the Accounting API with automatic authentication and configurable environments.

## 📁 Files Included

- `Accounting-API-Postman-Collection.json` - Main Postman collection with all API endpoints
- `Accounting-API-Environment.postman_environment.json` - Development environment configuration
- `Accounting-API-Production.postman_environment.json` - Production environment template

## 🚀 Quick Setup

### 1. Import Collection and Environment

1. Open Postman
2. Click **Import** button
3. Import the collection file: `Accounting-API-Postman-Collection.json`
4. Import the environment file: `Accounting-API-Environment.postman_environment.json`
5. Select the imported environment from the environment dropdown

### 2. Configure Base URL

The collection uses environment variables for easy configuration:

- **Development**: `http://localhost:3001` (default)
- **Production**: Update the production environment file with your actual domain

### 3. Authentication Setup

The collection includes **automatic authentication** management:

1. Use the **Login** request in the Authentication folder
2. The auth token will be **automatically extracted** and set as a collection variable
3. All subsequent requests will use this token automatically
4. Use **Refresh Token** to renew your session

## 📚 Collection Structure

### 🏥 Health & Info

- **Health Check** - `/health` - Application health status
- **Readiness Check** - `/ready` - Container readiness probe
- **Liveness Check** - `/live` - Container liveness probe
- **API Info** - `/api` - Available endpoints information

### 🔐 Authentication

- **Login** - `POST /api/v1/auth/login` - User authentication (auto-sets token)
- **Logout** - `POST /api/v1/auth/logout` - User logout
- **Get Profile** - `GET /api/v1/auth/profile` - Current user info
- **Refresh Token** - `POST /api/v1/auth/refresh` - Token renewal (auto-updates token)

### 👥 User Management

- **List Users** - `GET /api/v1/users` - Paginated user list (Admin only)
- **Get User by ID** - `GET /api/v1/users/:id` - User details
- **Create User** - `POST /api/v1/users` - New user creation (Admin only)
- **Update User** - `PUT /api/v1/users/:id` - User information update
- **Delete User** - `DELETE /api/v1/users/:id` - User soft deletion (Admin only)

### 💰 Account Management

#### General Accounts (Chart of Accounts)

- **List General Accounts** - `GET /api/v1/accounts/general` - Top-level accounts
- **Get General Account by ID** - `GET /api/v1/accounts/general/:id` - Account details
- **Create General Account** - `POST /api/v1/accounts/general` - New account creation

#### Detail Accounts (Sub-accounts)

- **List Detail Accounts** - `GET /api/v1/accounts/detail` - Sub-account listing

### 📚 Ledger Management (Double-Entry Bookkeeping)

- **List Ledger Entries** - `GET /api/v1/ledgers` - Transaction history with filtering
- **Get Ledger Entry by ID** - `GET /api/v1/ledgers/:id` - Transaction details
- **Create Bulk Ledger Entries** - `POST /api/v1/ledgers` - Double-entry transactions
- **Update Ledger Entry** - `PUT /api/v1/ledgers/:id` - Transaction updates
- **Delete Ledger Entry** - `DELETE /api/v1/ledgers/:id` - Transaction deletion

## 🔧 Advanced Features

### Automatic Token Management

The collection includes sophisticated token management:

```javascript
// Login Test Script (automatically runs after login)
if (pm.response.code === 200) {
  const jsonData = pm.response.json();
  if (jsonData.success && jsonData.data && jsonData.data.token) {
    pm.collectionVariables.set('authToken', jsonData.data.token);
    console.log('Auth token automatically set');
  }
}
```

### Environment Variables

Easily switch between environments:

| Variable        | Description    | Development             | Production  |
| --------------- | -------------- | ----------------------- | ----------- |
| `baseUrl`       | API base URL   | `http://localhost:3001` | Your domain |
| `apiVersion`    | API version    | `v1`                    | `v1`        |
| `authToken`     | JWT token      | Auto-set                | Auto-set    |
| `adminUsername` | Admin username | `admin`                 | Configure   |
| `adminPassword` | Admin password | `admin123456`           | Configure   |

### Query Parameters

Many endpoints support filtering and pagination:

#### User Management

- `page`, `limit` - Pagination
- `search` - Search users
- `role` - Filter by role (ADMIN, MANAJER, AKUNTAN, KASIR, KOLEKTOR, NASABAH)
- `status` - Filter by status (ACTIVE, INACTIVE)

#### Account Management

- `page`, `limit` - Pagination
- `accountCategory` - Filter by category (ASSET, HUTANG, MODAL, PENDAPATAN, BIAYA)
- `accountGeneralId` - Filter detail accounts by general account

#### Ledger Management

- `page`, `limit` - Pagination
- `search` - Search in description/reference
- `referenceNumber` - Filter by reference number
- `ledgerType` - Filter by type (KAS_MASUK, KAS_KELUAR)
- `transactionType` - Filter by type (DEBIT, CREDIT)
- `postingStatus` - Filter by status (PENDING, POSTED)
- `startDate`, `endDate` - Date range filtering
- `accountDetailId`, `accountGeneralId` - Account filtering
- `includeAccounts` - Include account details

## 💡 Usage Tips

### 1. Getting Started

1. Start with **Health Check** to verify API availability
2. Use **Login** to authenticate (token auto-set)
3. Check **Get Profile** to verify authentication
4. Explore endpoints based on your role

### 2. User Roles and Permissions

- **ADMIN** - Full access to all endpoints
- **MANAJER** - Management level access
- **AKUNTAN** - Accounting operations
- **KASIR** - Cash operations
- **KOLEKTOR** - Collection operations
- **NASABAH** - Customer level access

### 3. Double-Entry Bookkeeping

When creating ledger entries, ensure:

- Total debits = Total credits
- Use appropriate account categories
- Include meaningful descriptions

### 4. Error Handling

The API returns standardized error responses:

```json
{
  "success": false,
  "error": "ValidationError",
  "message": "Human readable message",
  "details": { ... }
}
```

## 🔄 Environment Switching

### Development Environment

```json
{
  "baseUrl": "http://localhost:3001",
  "adminUsername": "admin",
  "adminPassword": "admin123456"
}
```

### Production Environment

1. Update `baseUrl` with your production domain
2. Set proper production credentials
3. Ensure HTTPS is used for production

## 🛠️ Customization

### Adding New Requests

1. Right-click on appropriate folder
2. Add Request
3. Use collection variables: `{{baseUrl}}`, `{{apiVersion}}`
4. Authentication is inherited from collection level

### Custom Scripts

Add pre-request or test scripts for:

- Data validation
- Environment-specific logic
- Custom token handling
- Response processing

## 📞 Support

For API-related questions:

- Check the main API documentation
- Review error responses for details
- Verify authentication and permissions
- Ensure proper request formatting

## 🔐 Security Notes

- Never commit production credentials
- Use environment variables for sensitive data
- Regularly rotate authentication tokens
- Review and limit user permissions
- Use HTTPS in production environments
