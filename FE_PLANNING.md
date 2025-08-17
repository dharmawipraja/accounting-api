# Frontend Planning Guide

## Vite + React Frontend for Accounting API

I want to create UI that are elegant minimalist and easy to understand by user. I also want the web to be responsive so it can be open in desktop, tablet, and mobile.

### 📋 API Overview

Your Accounting API is a comprehensive RESTful service built with Fastify, featuring:

- **Authentication**: JWT-based with role-based access control (RBAC)
- **User Roles**: ADMIN, MANAJER, AKUNTAN, KASIR, KOLEKTOR, NASABAH
- **Database**: PostgreSQL with Prisma ORM
- **API Documentation**: OpenAPI/Swagger available
- **Security**: Rate limiting, CORS, CSRF protection, input validation

### 🎯 Key API Endpoints Analysis

#### Authentication (`/auth`)

- `POST /auth/login` - User login
- `POST /auth/logout` - User logout
- `GET /auth/profile` - Get current user profile

#### Users Management (`/users`) - Admin/Manager only

- `GET /users` - List users with pagination
- `POST /users` - Create user
- `GET /users/:id` - Get user by ID
- `PUT /users/:id` - Update user
- `DELETE /users/:id` - Delete user
- `POST /users/change-password` - Change password (any authenticated user)

#### Account General (`/accounts/general`) - Admin/Manager/Accountant only

- `GET /accounts/general` - List general accounts with pagination
- `POST /accounts/general` - Create general account
- `GET /accounts/general/:id` - Get general account by ID
- `PUT /accounts/general/:id` - Update general account
- `DELETE /accounts/general/:id` - Delete general account (soft delete)

#### Account Detail (`/accounts/detail`) - Admin/Manager/Accountant only

- `GET /accounts/detail` - List detail accounts with pagination
- `POST /accounts/detail` - Create detail account
- `GET /accounts/detail/:id` - Get detail account by ID
- `PUT /accounts/detail/:id` - Update detail account
- `DELETE /accounts/detail/:id` - Delete detail account (soft delete)

#### Ledgers (`/ledgers`) - Admin/Manager/Accountant only

- `GET /ledgers` - List ledger entries with pagination
- `POST /ledgers` - Create bulk ledger entries
- `GET /ledgers/:id` - Get ledger entry by ID
- `PUT /ledgers/:id` - Update ledger entry
- `DELETE /ledgers/:id` - Delete ledger entry

### 🏗️ Frontend Architecture Recommendations

#### Tech Stack

All tech stack and library should prioritize the latest current version, except there are incompatibility between version library. If that happens create comment to explain it

- **Framework**: Vite + React
- **TypeScript**: For type safety
- **State Management**: Redux Toolkit
- **Routing**: Tan Stack Router
- **UI Framework**: Tailwind and Shadcn
- **Form Management**: React Hook Form + Zod validation
- **Date Handling**: date-fns
- **HTTP Client**: Axios and Tan Stack Query
- **Table**: Tan Stack Table
- **Charts**: Recharts or Chart.js
- **Authentication**: Custom JWT handling

#### Folder Structure

```
src/
├── components/           # Reusable components
│   ├── common/          # Common UI components
│   ├── forms/           # Form components
│   ├── tables/          # Table components
│   └── charts/          # Chart components
├── pages/               # Page components
│   ├── auth/           # Login, profile pages
│   ├── users/          # User management
│   ├── accounts/       # Account management
│   ├── ledgers/        # Ledger management
│   └── dashboard/      # Dashboard and reports
├── hooks/              # Custom React hooks
├── services/           # API services and RTK Query
├── store/              # Redux store configuration
├── types/              # TypeScript type definitions
├── utils/              # Utility functions
├── constants/          # Application constants
└── styles/             # Global styles and themes
```

### 📱 Required Frontend Features

#### 🔐 Authentication & Authorization

- [x] Login form with username and password
- [x] JWT token storage and management
- [x] Role-based route protection
- [x] Auto-logout on token expiration
- [x] Profile management
- [x] Change password functionality

#### 👥 User Management (Admin/Manager)

- [x] User list with pagination and filtering
- [x] Create new user form
- [x] Edit user information
- [x] Delete user (with confirmation)
- [x] User role assignment
- [x] User status management (Active/Inactive)

#### 📊 Account Management (Admin/Manager/Accountant)

- [x] General Accounts CRUD operations
- [x] Detail Accounts CRUD operations
- [x] Account categorization (ASSET, HUTANG, MODAL, etc.)
- [x] Account numbering system
- [x] Account hierarchy display
- [x] Search and filter functionality

#### 📋 Ledger Management (Admin/Manager/Accountant)

- [x] Ledger entry creation (bulk operations)
- [x] Ledger entry listing with advanced filtering
- [x] Ledger entry editing
- [x] Transaction type handling (DEBIT/CREDIT)
- [x] Reference number tracking
- [x] Posting status management

#### 📈 Dashboard & Reports

- [x] Financial overview dashboard
- [x] Balance sheet generation
- [x] Profit & Loss statement
- [x] Account balance summaries
- [x] Transaction history charts
- [x] Export functionality (PDF/Excel)

### 📋 Development Todo List

#### Phase 1: Project Setup & Authentication

- [ ] **Project Initialization**
  - [ ] Create Vite + React + TypeScript project
  - [ ] Configure ESLint, Prettier, and Git hooks
  - [ ] Set up folder structure
  - [ ] Install and configure dependencies

- [ ] **Environment Configuration**
  - [ ] Create environment variables for API base URL
  - [ ] Configure different environments (dev, staging, prod)
  - [ ] Set up proxy for development

- [ ] **Authentication System**
  - [ ] Implement JWT token storage (localStorage/sessionStorage)
  - [ ] Create authentication context/slice
  - [ ] Build login page with form validation
  - [ ] Implement automatic token refresh logic
  - [ ] Create protected route wrapper
  - [ ] Build logout functionality

#### Phase 2: Core Infrastructure

- [ ] **State Management**
  - [ ] Configure Redux Toolkit store
  - [ ] Set up RTK Query for API calls
  - [ ] Create authentication slice
  - [ ] Create UI state slice (loading, notifications)

- [ ] **API Integration**
  - [ ] Create base API service with axios
  - [ ] Implement request/response interceptors
  - [ ] Create RTK Query endpoints for all API routes
  - [ ] Add error handling and retry logic
  - [ ] Implement caching strategies

- [ ] **UI Foundation**
  - [ ] Choose and configure UI framework (Ant Design/MUI)
  - [ ] Create layout components (Header, Sidebar, Footer)
  - [ ] Implement responsive design
  - [ ] Create common components (Button, Input, Modal, etc.)
  - [ ] Set up routing with role-based access

#### Phase 3: User Management Module

- [ ] **User List Page**
  - [ ] Create user table with pagination
  - [ ] Implement search and filtering
  - [ ] Add sorting functionality
  - [ ] Create role-based action buttons

- [ ] **User Forms**
  - [ ] Build create user form with validation
  - [ ] Build edit user form
  - [ ] Implement role selection component
  - [ ] Add password change form

- [ ] **User Operations**
  - [ ] Implement user creation flow
  - [ ] Implement user editing flow
  - [ ] Implement user deletion with confirmation
  - [ ] Add user status toggle functionality

#### Phase 4: Account Management Module

- [ ] **General Accounts**
  - [ ] Create general accounts list page
  - [ ] Build account creation form
  - [ ] Implement account editing
  - [ ] Add account deletion functionality
  - [ ] Create account category filters

- [ ] **Detail Accounts**
  - [ ] Create detail accounts list page
  - [ ] Build detail account forms
  - [ ] Implement hierarchy display
  - [ ] Add relationship to general accounts
  - [ ] Create account number validation

- [ ] **Account Features**
  - [ ] Implement search across accounts
  - [ ] Add bulk operations
  - [ ] Create account balance display
  - [ ] Implement soft delete handling

#### Phase 5: Ledger Management Module

- [ ] **Ledger Entry List**
  - [ ] Create ledger entries table
  - [ ] Implement advanced filtering (date range, account, type)
  - [ ] Add sorting and pagination
  - [ ] Create status indicators

- [ ] **Ledger Operations**
  - [ ] Build bulk ledger entry form
  - [ ] Implement double-entry validation
  - [ ] Create ledger entry editing
  - [ ] Add posting/unposting functionality
  - [ ] Implement reference number generation

- [ ] **Transaction Management**
  - [ ] Create transaction grouping display
  - [ ] Implement balance calculations
  - [ ] Add transaction reversal functionality
  - [ ] Create audit trail display

#### Phase 6: Dashboard & Reports

- [ ] **Dashboard**
  - [ ] Create overview dashboard
  - [ ] Implement financial KPI cards
  - [ ] Add recent transactions widget
  - [ ] Create account balance charts
  - [ ] Add quick action buttons

- [ ] **Reports**
  - [ ] Build balance sheet report
  - [ ] Create profit & loss statement
  - [ ] Implement trial balance
  - [ ] Add general ledger report
  - [ ] Create cash flow statement

- [ ] **Export Features**
  - [ ] Implement PDF export
  - [ ] Add Excel export functionality
  - [ ] Create print-friendly layouts
  - [ ] Add email report functionality

#### Phase 7: Advanced Features

- [ ] **Search & Filtering**
  - [ ] Implement global search
  - [ ] Create advanced filter components
  - [ ] Add saved filter presets
  - [ ] Implement date range pickers

- [ ] **Notifications**
  - [ ] Create notification system
  - [ ] Implement real-time updates
  - [ ] Add email notifications
  - [ ] Create audit alerts

- [ ] **Performance Optimization**
  - [ ] Implement virtual scrolling for large lists
  - [ ] Add data caching strategies
  - [ ] Optimize bundle size
  - [ ] Implement lazy loading

#### Phase 8: Testing & Quality

- [ ] **Testing**
  - [ ] Set up Vitest for unit testing
  - [ ] Write component tests
  - [ ] Add integration tests
  - [ ] Implement E2E tests with Playwright

- [ ] **Quality Assurance**
  - [ ] Add accessibility features
  - [ ] Implement error boundaries
  - [ ] Add loading states
  - [ ] Create proper error messages

### 🎨 UI/UX Considerations

#### Design Principles

- **Clean & Professional**: Modern accounting software aesthetic
- **Responsive**: Works on desktop, tablet, and mobile
- **Accessible**: WCAG 2.1 compliance
- **Fast**: Optimized for quick data entry and navigation

#### Key UI Components Needed

- **Data Tables**: With sorting, filtering, and pagination
- **Forms**: Complex forms with validation and auto-save
- **Charts**: Financial charts and graphs
- **Modals**: For confirmations and detailed views
- **Navigation**: Role-based menu system
- **Breadcrumbs**: For deep navigation tracking

### 🔧 Technical Specifications

#### API Integration Details

- **Base URL**: Configure in environment variables
- **Authentication**: Bearer token in Authorization header
- **Response Format**: All responses follow `{ success: boolean, data: any, message?: string }` format
- **Pagination**: Uses `page` and `limit` query parameters
- **Error Handling**: HTTP status codes with detailed error messages

#### Type Definitions (TypeScript)

```typescript
// ===============================
// RESPONSE TYPES (What API Returns)
// ===============================

// Base response wrapper
interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
  message?: string;
}

// User types
interface User {
  id: string;
  username: string;
  name: string;
  role: 'ADMIN' | 'MANAJER' | 'AKUNTAN' | 'KASIR' | 'KOLEKTOR' | 'NASABAH';
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
}

// Authentication response
interface AuthResponse {
  token: string;
  user: {
    id: string;
    username: string;
    name: string;
    role: 'ADMIN' | 'MANAJER' | 'AKUNTAN' | 'KASIR' | 'KOLEKTOR' | 'NASABAH';
  };
  expiresIn: string; // default: "24h"
}

// Account types
interface AccountGeneral {
  id: string;
  accountNumber: string;
  accountName: string;
  accountType: 'GENERAL';
  accountCategory: 'ASSET' | 'HUTANG' | 'MODAL' | 'PENDAPATAN' | 'BIAYA';
  reportType: 'NERACA' | 'LABA_RUGI';
  transactionType: 'DEBIT' | 'CREDIT';
  amountCredit: number;
  amountDebit: number;
  createdBy: string;
  updatedBy: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AccountDetail {
  id: string;
  accountNumber: string;
  accountName: string;
  accountType: 'DETAIL';
  accountCategory: 'ASSET' | 'HUTANG' | 'MODAL' | 'PENDAPATAN' | 'BIAYA';
  reportType: 'NERACA' | 'LABA_RUGI';
  transactionType: 'DEBIT' | 'CREDIT';
  amountCredit: number;
  amountDebit: number;
  accountGeneralId: string;
  createdBy: string;
  updatedBy: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  accountGeneral?: {
    id: string;
    accountNumber: string;
    accountName: string;
  };
}

// Ledger types
interface Ledger {
  id: string;
  referenceNumber: string;
  amount: number;
  description: string;
  ledgerType: 'KAS_MASUK' | 'KAS_KELUAR';
  transactionType: 'DEBIT' | 'CREDIT';
  postingStatus: 'PENDING' | 'POSTED';
  ledgerDate: string;
  postingAt?: string | null;
  accountDetailId: string;
  accountGeneralId: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  accountDetail?: {
    id: string;
    accountNumber: string;
    accountName: string;
  };
  accountGeneral?: {
    id: string;
    accountNumber: string;
    accountName: string;
  };
}

// ===============================
// REQUEST PAYLOAD TYPES (What Frontend Sends)
// ===============================

// Authentication payloads
interface LoginPayload {
  username: string; // min: 3 chars, alphanumeric + underscore/hyphen
  password: string; // min: 6 chars
}

// User management payloads
interface CreateUserPayload {
  username: string; // min: 3 chars, max: 50, alphanumeric + underscore/hyphen
  password: string; // min: 6 chars
  name: string; // min: 2 chars, max: 100
  role?: 'ADMIN' | 'MANAJER' | 'AKUNTAN' | 'KASIR' | 'KOLEKTOR' | 'NASABAH'; // default: 'NASABAH'
  status?: 'ACTIVE' | 'INACTIVE'; // default: 'ACTIVE'
}

interface UpdateUserPayload {
  username?: string; // min: 3 chars, max: 50, alphanumeric + underscore/hyphen
  password?: string; // min: 6 chars
  name?: string; // min: 2 chars, max: 100
  role?: 'ADMIN' | 'MANAJER' | 'AKUNTAN' | 'KASIR' | 'KOLEKTOR' | 'NASABAH';
  status?: 'ACTIVE' | 'INACTIVE';
}

interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string; // min: 6 chars
  confirmPassword: string; // must match newPassword
}

// Account management payloads
interface CreateAccountGeneralPayload {
  accountNumber: string; // min: 1, max: 20, numbers and hyphens only
  accountName: string; // min: 3 chars, max: 100
  accountCategory: 'ASSET' | 'HUTANG' | 'MODAL' | 'PENDAPATAN' | 'BIAYA';
  reportType: 'NERACA' | 'LABA_RUGI';
  transactionType: 'DEBIT' | 'CREDIT';
  amountCredit?: number; // default: 0, positive decimal
  amountDebit?: number; // default: 0, positive decimal
}

interface UpdateAccountGeneralPayload {
  accountName: string; // min: 3 chars, max: 100
  accountCategory: 'ASSET' | 'HUTANG' | 'MODAL' | 'PENDAPATAN' | 'BIAYA';
  reportType: 'NERACA' | 'LABA_RUGI';
  transactionType: 'DEBIT' | 'CREDIT';
  amountCredit: number; // positive decimal
  amountDebit: number; // positive decimal
}

interface CreateAccountDetailPayload {
  accountNumber: string; // min: 1, max: 20, numbers and hyphens only
  accountName: string; // min: 3 chars, max: 100
  accountGeneralId: string; // UUID
  accountCategory: 'ASSET' | 'HUTANG' | 'MODAL' | 'PENDAPATAN' | 'BIAYA';
  reportType: 'NERACA' | 'LABA_RUGI';
  transactionType: 'DEBIT' | 'CREDIT';
  amountCredit?: number; // default: 0, positive decimal
  amountDebit?: number; // default: 0, positive decimal
}

interface UpdateAccountDetailPayload {
  accountName: string; // min: 3 chars, max: 100
  accountCategory: 'ASSET' | 'HUTANG' | 'MODAL' | 'PENDAPATAN' | 'BIAYA';
  reportType: 'NERACA' | 'LABA_RUGI';
  transactionType: 'DEBIT' | 'CREDIT';
  amountCredit: number; // positive decimal
  amountDebit: number; // positive decimal
}

// Ledger management payloads
interface LedgerItem {
  amount: number; // positive decimal
  description: string; // min: 3 chars, max: 500
  accountDetailId: string; // UUID
  accountGeneralId: string; // UUID
  ledgerType: 'KAS_MASUK' | 'KAS_KELUAR';
  transactionType: 'DEBIT' | 'CREDIT';
  ledgerDate: string; // ISO date string
}

interface CreateBulkLedgersPayload {
  ledgers: LedgerItem[]; // min: 1 item, max: 100 items
}

interface UpdateLedgerPayload {
  amount?: number; // positive decimal
  description?: string; // min: 3 chars, max: 500
  accountDetailId?: string; // UUID
  accountGeneralId?: string; // UUID
  ledgerType?: 'KAS_MASUK' | 'KAS_KELUAR';
  transactionType?: 'DEBIT' | 'CREDIT';
  ledgerDate?: string; // ISO date string
  postingStatus?: 'PENDING' | 'POSTED';
}

// ===============================
// QUERY PARAMETERS TYPES
// ===============================

// Common pagination params
interface PaginationParams {
  page?: number; // default: 1, min: 1
  limit?: number; // default: 10, min: 1, max: 100
}

// User query params
interface UserQueryParams extends PaginationParams {
  search?: string; // searches username and name
  role?: 'ADMIN' | 'MANAJER' | 'AKUNTAN' | 'KASIR' | 'KOLEKTOR' | 'NASABAH';
  status?: 'ACTIVE' | 'INACTIVE';
  createdFrom?: string; // ISO date string
  createdTo?: string; // ISO date string
  includeInactive?: boolean; // default: false
}

// Account query params
interface AccountQueryParams extends PaginationParams {
  search?: string; // searches account number and name
  accountCategory?: 'ASSET' | 'HUTANG' | 'MODAL' | 'PENDAPATAN' | 'BIAYA';
  reportType?: 'NERACA' | 'LABA_RUGI';
  includeDeleted?: boolean; // default: false
}

// Account detail specific query params
interface AccountDetailQueryParams extends AccountQueryParams {
  accountGeneralId?: string; // filter by parent general account
  includeLedgers?: boolean; // default: false
}

// Ledger query params
interface LedgerQueryParams extends PaginationParams {
  search?: string; // searches description and reference number
  accountDetailId?: string;
  accountGeneralId?: string;
  ledgerType?: 'KAS_MASUK' | 'KAS_KELUAR';
  postingStatus?: 'PENDING' | 'POSTED';
  dateFrom?: string; // ISO date string
  dateTo?: string; // ISO date string
  amountMin?: number;
  amountMax?: number;
}
```

### 🚀 Deployment Considerations

#### Build Configuration

- **Environment Variables**: API_BASE_URL, ENVIRONMENT
- **Build Optimization**: Code splitting, tree shaking
- **Asset Optimization**: Image compression, lazy loading
- **PWA Features**: Service worker, offline capabilities

#### Production Setup

- **Hosting**: Vercel, Netlify, or custom server
- **CDN**: For static assets
- **Monitoring**: Error tracking with Sentry
- **Analytics**: User behavior tracking

### 📚 Documentation Needed

- [ ] **API Integration Guide**: How to connect to your API
- [ ] **Component Documentation**: Storybook setup
- [ ] **User Manual**: How to use the frontend
- [ ] **Deployment Guide**: How to deploy the application
- [ ] **Contributing Guide**: For future developers

### 🔍 Next Steps

1. **Start with Phase 1**: Set up the project foundation
2. **API Testing**: Test all endpoints with Postman/Insomnia
3. **UI Mockups**: Create wireframes for key pages
4. **MVP Definition**: Define minimum viable product features
5. **Timeline Planning**: Create realistic development timeline

### � API Endpoints with Required Payloads

#### Authentication Endpoints

**POST /auth/login**

```typescript
// Request Body
{
  username: string; // min: 3 chars, alphanumeric + underscore/hyphen
  password: string; // min: 6 chars
}

// Response
ApiResponse<AuthResponse>;
```

**POST /auth/logout** (requires auth)

```typescript
// Request Body: None (just auth header)
// Response
ApiResponse<{ message: string }>;
```

**GET /auth/profile** (requires auth)

```typescript
// Request Body: None
// Response
ApiResponse<{
  id: string;
  username: string;
  name: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}>;
```

#### User Management Endpoints (Admin/Manager only)

**POST /users**

```typescript
// Request Body
CreateUserPayload;

// Response
ApiResponse<User>;
```

**GET /users**

```typescript
// Query Parameters
UserQueryParams;

// Response
PaginatedResponse<User>;
```

**GET /users/:id**

```typescript
// Path Parameters
{
  id: string;
}

// Response
ApiResponse<User>;
```

**PUT /users/:id**

```typescript
// Path Parameters
{
  id: string;
}

// Request Body
UpdateUserPayload;

// Response
ApiResponse<User>;
```

**DELETE /users/:id**

```typescript
// Path Parameters
{
  id: string;
}

// Response
ApiResponse<User>;
```

**POST /users/change-password** (any authenticated user)

```typescript
// Request Body
ChangePasswordPayload;

// Response
ApiResponse<{ message: string }>;
```

#### Account General Endpoints (Admin/Manager/Accountant only)

**POST /accounts/general**

```typescript
// Request Body
CreateAccountGeneralPayload;

// Response (201)
ApiResponse<AccountGeneral>;
```

**GET /accounts/general**

```typescript
// Query Parameters
AccountQueryParams;

// Response
PaginatedResponse<AccountGeneral>;
```

**GET /accounts/general/:id**

```typescript
// Path Parameters
{ id: string }

// Query Parameters
{ includeDeleted?: boolean } // default: false

// Response
ApiResponse<AccountGeneral>
```

**PUT /accounts/general/:id**

```typescript
// Path Parameters
{
  id: string;
}

// Request Body
UpdateAccountGeneralPayload;

// Response
ApiResponse<AccountGeneral>;
```

**DELETE /accounts/general/:id** (soft delete)

```typescript
// Path Parameters
{
  id: string;
}

// Response
ApiResponse<AccountGeneral>;
```

#### Account Detail Endpoints (Admin/Manager/Accountant only)

**POST /accounts/detail**

```typescript
// Request Body
CreateAccountDetailPayload;

// Response (201)
ApiResponse<AccountDetail>;
```

**GET /accounts/detail**

```typescript
// Query Parameters
AccountDetailQueryParams;

// Response
PaginatedResponse<AccountDetail>;
```

**GET /accounts/detail/:id**

```typescript
// Path Parameters
{ id: string }

// Query Parameters
{
  includeDeleted?: boolean;  // default: false
  includeLedgers?: boolean;  // default: false
}

// Response
ApiResponse<AccountDetail>
```

**PUT /accounts/detail/:id**

```typescript
// Path Parameters
{
  id: string;
}

// Request Body
UpdateAccountDetailPayload;

// Response
ApiResponse<AccountDetail>;
```

**DELETE /accounts/detail/:id** (soft delete)

```typescript
// Path Parameters
{
  id: string;
}

// Response
ApiResponse<AccountDetail>;
```

#### Ledger Endpoints (Admin/Manager/Accountant only)

**POST /ledgers** (bulk creation)

```typescript
// Request Body
CreateBulkLedgersPayload;

// Response (201)
ApiResponse<{
  referenceNumber: string;
  totalEntries: number;
  ledgers: Ledger[];
}>;
```

**GET /ledgers**

```typescript
// Query Parameters
LedgerQueryParams;

// Response
PaginatedResponse<Ledger>;
```

**GET /ledgers/:id**

```typescript
// Path Parameters
{
  id: string;
}

// Response
ApiResponse<Ledger>;
```

**PUT /ledgers/:id**

```typescript
// Path Parameters
{
  id: string;
}

// Request Body
UpdateLedgerPayload;

// Response
ApiResponse<Ledger>;
```

**DELETE /ledgers/:id** (only pending entries)

```typescript
// Path Parameters
{
  id: string;
}

// Response
ApiResponse<Ledger>;
```

#### Health Check Endpoints (No auth required)

**GET /health**

```typescript
// Request: None
// Response
{
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  database: {
    healthy: boolean;
    version?: string;
    connections?: number;
    tableCount?: number;
    responseTime?: number;
  };
}
```

**GET /ready**

```typescript
// Request: None
// Response
{
  status: 'healthy' | 'degraded' | 'unhealthy';
  // Additional readiness data
}
```

**GET /live**

```typescript
// Request: None
// Response
{
  status: 'healthy' | 'degraded' | 'unhealthy';
}
```

### �📞 API Endpoints Quick Reference

```
Base URL: http://localhost:3000 (or your configured URL)

Authentication:
POST   /auth/login
POST   /auth/logout
GET    /auth/profile

Users:
GET    /users
POST   /users
GET    /users/:id
PUT    /users/:id
DELETE /users/:id
POST   /users/change-password

Accounts:
GET    /accounts/general
POST   /accounts/general
GET    /accounts/general/:id
PUT    /accounts/general/:id
DELETE /accounts/general/:id

GET    /accounts/detail
POST   /accounts/detail
GET    /accounts/detail/:id
PUT    /accounts/detail/:id
DELETE /accounts/detail/:id

Ledgers:
GET    /ledgers
POST   /ledgers
GET    /ledgers/:id
PUT    /ledgers/:id
DELETE /ledgers/:id

Health:
GET    /health
GET    /ready
GET    /live
```

### 🔒 Important Validation Rules & Business Logic

#### Authentication & Authorization

- **JWT Token**: Include in `Authorization: Bearer <token>` header for protected routes
- **Token Expiry**: Default 24 hours, handle auto-refresh or re-login
- **Role Hierarchy**: ADMIN > MANAJER > AKUNTAN > KASIR > KOLEKTOR > NASABAH
- **Permission Matrix**:
  - Users: Admin, Manager only
  - Accounts: Admin, Manager, Accountant only
  - Ledgers: Admin, Manager, Accountant only
  - Profile/Password change: Any authenticated user

#### Field Validation Rules

- **Username**: 3-50 chars, alphanumeric + underscore/hyphen only
- **Password**: Minimum 6 characters
- **Name**: 2-100 characters
- **Account Number**: Numbers and hyphens only, max 20 chars
- **Account Name**: 3-100 characters
- **Description**: 3-500 characters for ledger descriptions
- **Amounts**: Positive decimals only
- **UUIDs**: Standard UUID v4 format for all IDs

#### Business Rules

- **Account Hierarchy**: Detail accounts must belong to a General account
- **Ledger Entries**: Must be created in bulk (1-100 entries per batch)
- **Soft Deletes**: Accounts use soft delete (deletedAt field)
- **Posting Status**: Ledgers can be PENDING or POSTED
- **Double Entry**: Ensure debit = credit for accounting accuracy
- **Reference Numbers**: Auto-generated for ledger batches

#### Error Handling

- **400**: Validation errors with detailed field messages
- **401**: Authentication required or token expired
- **403**: Insufficient permissions for the operation
- **404**: Resource not found
- **409**: Conflict (e.g., duplicate account number)
- **429**: Rate limit exceeded
- **500**: Internal server error

#### Frontend Implementation Tips

1. **Form Validation**: Use Zod schemas matching the API validation
2. **Loading States**: Show loading for all async operations
3. **Error Display**: Show field-specific validation errors
4. **Pagination**: Handle large datasets with proper pagination
5. **Search/Filter**: Implement debounced search and advanced filters
6. **Caching**: Cache frequently accessed data (accounts, user lists)
7. **Optimistic Updates**: For better UX on successful operations
8. **Confirmation Dialogs**: For delete operations and state changes
9. **Auto-save**: For long forms to prevent data loss
10. **Accessibility**: Proper ARIA labels and keyboard navigation

This comprehensive planning document provides a roadmap for building a professional frontend for your accounting API. Start with the foundation and build incrementally to ensure a robust and maintainable application.
