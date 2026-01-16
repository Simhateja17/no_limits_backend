# Authentication API Documentation

## Overview
Complete JWT-based authentication system for the No Limits application with role-based access control.

## Base URL
```
http://localhost:3001/api
```

## Available Endpoints

### 1. Register New User (Admin Only)
**POST** `/auth/register`

Create a new user account. **Requires SUPER_ADMIN authentication.**

**Headers:**
```
Authorization: Bearer <superAdminAccessToken>
```

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe",
  "role": "CLIENT",
  "companyName": "Example Company",
  "phone": "+49 123 456789",
  "address": "Street 123, City"
}
```

**Response:**
```json
{
  "message": "User registered successfully",
  "user": {
    "id": "clx...",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "CLIENT",
    "isActive": true,
    "client": { ... }
  },
  "accessToken": "eyJhbG..."
}
```

### 2. Login
**POST** `/auth/login`

Login with email and password.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "message": "Login successful",
  "user": {
    "id": "clx...",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "CLIENT",
    ...
  },
  "accessToken": "eyJhbG..."
}
```

### 3. Logout
**POST** `/auth/logout`

Logout current user (requires authentication).

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Response:**
```json
{
  "message": "Logout successful"
}
```

### 4. Refresh Token
**POST** `/auth/refresh`

Refresh the access token using refresh token from cookies.

**Response:**
```json
{
  "message": "Token refreshed successfully",
  "accessToken": "eyJhbG..."
}
```

### 5. Get Current User
**GET** `/auth/me`

Get the currently authenticated user's information.

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Response:**
```json
{
  "user": {
    "id": "clx...",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "CLIENT",
    "client": { ... }
  }
}
```

### 6. Change Password
**POST** `/auth/change-password`

Change the current user's password (requires authentication).

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Request Body:**
```json
{
  "currentPassword": "oldpassword123",
  "newPassword": "newpassword456"
}
```

**Response:**
```json
{
  "message": "Password changed successfully"
}
```

## User Roles

- **SUPER_ADMIN**: Full access to all features, can impersonate customers
- **ADMIN**: Warehouse owner with management access
- **EMPLOYEE**: Warehouse staff with limited access
- **CLIENT**: Shop owner with access to their own data

## Test Credentials

After running `npm run prisma:seed`, you can use these test accounts:

| Role | Email | Password |
|------|-------|----------|
| Super Admin | superadmin@nolimits.com | password123 |
| Admin | admin@nolimits.com | password123 |
| Employee | employee@nolimits.com | password123 |
| Client 1 | papercrush@example.com | password123 |
| CliLogin** with existing credentials to get an access token (only Super Admin can register new users)
| Client 3 | terppens@example.com | password123 |

## Authentication Flow

1. **Register** or **Login** to get an access token
2. Include the token in the `Authorization` header as `Bearer <token>` for protected routes
3. Access token expires in 7 days
4. Refresh token stored in httpOnly cookie expires in 30 days
5. Use `/auth/refresh` to get a new access token before it expires

## Middleware Usage

### Protect routes with authentication:
```typescript
import { authenticate } from '../middleware/auth.js';

router.get('/protected', authenticate, handler);
```

### Protect routes with role-based authorization:
```typescript
import { authorize, requireSuperAdmin } from '../middleware/auth.js';

// Only SUPER_ADMIN can access
router.get('/admin-only', requireSuperAdmin, handler);

// SUPER_ADMIN or ADMIN can access
router.get('/admin-area', authorize('SUPER_ADMIN', 'ADMIN'), handler);
```

## Security Features

- ✅ Password hashing with bcrypt (10 rounds)
- ✅ JWT access tokens (7 days expiry)
- ✅ JWT refresh tokens (30 days expiry, httpOnly cookie)
- ✅ Role-based access control (RBAC)
- ✅ Secure cookie settings (httpOnly, sameSite strict)
- ✅ Password change endpoint
- ✅ User account activation status

## Error Responses

All endpoints return appropriate HTTP status codes:

- `200` - Success
- `201` - Created
- `400` - Bad Request (validation error)
- `401` - Unauthorized (authentication required or invalid credentials)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error

Error response format:
```json
{
  "error": "Error message description"
}
```
