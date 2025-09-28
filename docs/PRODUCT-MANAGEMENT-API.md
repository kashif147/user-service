# Product Management API Documentation

## Overview

This document describes the Product Management API endpoints for managing product types, products, and pricing information. The API supports CRUD operations with role-based access control and tenant isolation.

## Base URL

```
/api/product-types
/api/products
/api/pricing
```

## Authentication

All endpoints require valid JWT token in Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

## Role-Based Access Control

- **SU (Super User)**: Full access to all operations
- **ASU (Assistant Super User)**: Create, Read, Update access
- **Other roles**: Read-only access (where applicable)

---

## Product Type Endpoints

### 1. Get All Product Types

**GET** `/api/product-types`

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "_id": "product_type_id",
      "name": "Membership",
      "code": "MEM",
      "description": "Annual membership fees for different member categories",
      "status": "Active",
      "isActive": true,
      "productsCount": 9,
      "createdBy": {
        "_id": "user_id",
        "name": "John Doe",
        "email": "john@example.com"
      },
      "updatedBy": {
        "_id": "user_id",
        "name": "Jane Smith",
        "email": "jane@example.com"
      },
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-12-01T14:45:00.000Z"
    }
  ],
  "count": 1
}
```

### 2. Get Single Product Type

**GET** `/api/product-types/:id`

**Response:** Same as above (single object)

### 3. Create New Product Type

**POST** `/api/product-types`
**Required Roles:** SU, ASU

**Request Body:**

```json
{
  "name": "Professional Events",
  "code": "EVENTS",
  "description": "Conferences, seminars, and networking events",
  "status": "Active"
}
```

**Required Fields:** `name`, `code`

### 4. Update Product Type

**PUT** `/api/product-types/:id`
**Required Roles:** SU, ASU

**Request Body:**

```json
{
  "name": "Updated Product Type",
  "code": "UPDATED",
  "description": "Updated description",
  "status": "Active"
}
```

### 5. Delete Product Type

**DELETE** `/api/product-types/:id`
**Required Roles:** SU

**Response:**

```json
{
  "success": true,
  "message": "Product type deleted successfully"
}
```

---

## Product Endpoints

### 1. Get All Products

**GET** `/api/products`

**Query Parameters:**

- `productTypeId` (optional): Filter by product type

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "_id": "product_id",
      "name": "General (all grades)",
      "code": "MEM-GEN",
      "description": "Standard membership for all nursing grades",
      "productType": {
        "_id": "product_type_id",
        "name": "Membership",
        "code": "MEM",
        "description": "Annual membership fees"
      },
      "status": "Active",
      "isActive": true,
      "currentPricing": {
        "_id": "pricing_id",
        "currency": "EUR",
        "price": 299,
        "effectiveFrom": "2025-01-01T00:00:00.000Z",
        "effectiveTo": "2025-12-31T23:59:59.000Z"
      },
      "createdBy": {
        "_id": "user_id",
        "name": "John Doe",
        "email": "john@example.com"
      },
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-12-01T14:45:00.000Z"
    }
  ],
  "count": 1
}
```

### 2. Get Products by Product Type (Drill-down)

**GET** `/api/products/by-type/:productTypeId`

**Response:**

```json
{
  "success": true,
  "data": {
    "productType": {
      "_id": "product_type_id",
      "name": "Membership",
      "code": "MEM",
      "description": "Annual membership fees"
    },
    "products": [
      {
        "_id": "product_id",
        "name": "General (all grades)",
        "code": "MEM-GEN",
        "description": "Standard membership for all nursing grades",
        "status": "Active",
        "isActive": true,
        "currentPricing": {
          "_id": "pricing_id",
          "currency": "EUR",
          "price": 299,
          "effectiveFrom": "2025-01-01T00:00:00.000Z",
          "effectiveTo": "2025-12-31T23:59:59.000Z"
        }
      }
    ],
    "count": 1
  }
}
```

### 3. Get Single Product

**GET** `/api/products/:id`

**Response:** Includes product details with pricing history

### 4. Create New Product

**POST** `/api/products`
**Required Roles:** SU, ASU

**Request Body:**

```json
{
  "name": "Postgraduate Student",
  "code": "MEM-PG",
  "description": "Membership for postgraduate students",
  "productTypeId": "product_type_id",
  "status": "Active"
}
```

**Required Fields:** `name`, `code`, `productTypeId`

### 5. Update Product

**PUT** `/api/products/:id`
**Required Roles:** SU, ASU

### 6. Delete Product

**DELETE** `/api/products/:id`
**Required Roles:** SU

---

## Pricing Endpoints

### 1. Get All Pricing

**GET** `/api/pricing`

**Query Parameters:**

- `productId` (optional): Filter by product

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "_id": "pricing_id",
      "product": {
        "_id": "product_id",
        "name": "General (all grades)",
        "code": "MEM-GEN",
        "description": "Standard membership"
      },
      "currency": "EUR",
      "price": 299,
      "effectiveFrom": "2025-01-01T00:00:00.000Z",
      "effectiveTo": "2025-12-31T23:59:59.000Z",
      "status": "Active",
      "isActive": true,
      "createdBy": {
        "_id": "user_id",
        "name": "John Doe",
        "email": "john@example.com"
      },
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-12-01T14:45:00.000Z"
    }
  ],
  "count": 1
}
```

### 2. Get Pricing by Product

**GET** `/api/pricing/by-product/:productId`

**Response:** All pricing history for a specific product

### 3. Get Current Pricing

**GET** `/api/pricing/current/:productId`

**Response:** Current active pricing for a product

### 4. Create New Pricing

**POST** `/api/pricing`
**Required Roles:** SU, ASU

**Request Body:**

```json
{
  "productId": "product_id",
  "currency": "EUR",
  "price": 299,
  "effectiveFrom": "2025-01-01",
  "effectiveTo": "2025-12-31",
  "status": "Active"
}
```

**Required Fields:** `productId`, `currency`, `price`, `effectiveFrom`

### 5. Update Pricing

**PUT** `/api/pricing/:id`
**Required Roles:** SU, ASU

### 6. Delete Pricing

**DELETE** `/api/pricing/:id`
**Required Roles:** SU

---

## Error Responses

### 400 Bad Request

```json
{
  "success": false,
  "error": {
    "message": "Validation Error",
    "code": "VALIDATION_ERROR",
    "status": 400,
    "details": ["Name is required", "Code must be unique"]
  },
  "correlationId": "uuid"
}
```

### 401 Unauthorized

```json
{
  "success": false,
  "error": {
    "message": "Unauthorized",
    "code": "UNAUTHORIZED",
    "status": 401
  },
  "correlationId": "uuid"
}
```

### 403 Forbidden

```json
{
  "success": false,
  "error": {
    "message": "Forbidden",
    "code": "FORBIDDEN",
    "status": 403
  },
  "correlationId": "uuid"
}
```

### 404 Not Found

```json
{
  "success": false,
  "error": {
    "message": "Product type not found",
    "code": "NOT_FOUND",
    "status": 404
  },
  "correlationId": "uuid"
}
```

### 500 Internal Server Error

```json
{
  "success": false,
  "error": {
    "message": "Internal Server Error",
    "code": "INTERNAL_SERVER_ERROR",
    "status": 500
  },
  "correlationId": "uuid"
}
```

---

## Features

### 1. Drill-down Functionality

- Get all products within a specific product type
- Endpoint: `GET /api/products/by-type/:productTypeId`

### 2. Pricing Management

- Support for multiple currencies
- Date range validation (effectiveFrom/effectiveTo)
- Overlap prevention for pricing periods
- Current pricing retrieval

### 3. Tenant Isolation

- All data is isolated by tenant
- Automatic tenant filtering on all queries

### 4. Soft Delete

- Records are soft deleted (isDeleted: true)
- Prevents deletion if dependent records exist

### 5. Audit Trail

- Created by and updated by tracking
- Timestamps for all operations

### 6. Validation

- Unique code validation per tenant
- Required field validation
- Date range validation for pricing

---

## Usage Examples

### Frontend Integration

```javascript
// Get all product types
const productTypes = await fetch("/api/product-types", {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

// Get products for a specific product type (drill-down)
const products = await fetch(`/api/products/by-type/${productTypeId}`, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

// Create new product
const newProduct = await fetch("/api/products", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "New Product",
    code: "NEW-PROD",
    description: "Product description",
    productTypeId: "product_type_id",
  }),
});

// Get current pricing for a product
const currentPricing = await fetch(`/api/pricing/current/${productId}`, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
```

---

## Database Schema

### ProductType Collection

```javascript
{
  _id: ObjectId,
  name: String,
  code: String (unique per tenant),
  description: String,
  status: String (Active/Inactive),
  isActive: Boolean,
  isDeleted: Boolean,
  createdBy: ObjectId (ref: User),
  updatedBy: ObjectId (ref: User),
  tenantId: String,
  createdAt: Date,
  updatedAt: Date
}
```

### Product Collection

```javascript
{
  _id: ObjectId,
  name: String,
  code: String (unique per tenant),
  description: String,
  productTypeId: ObjectId (ref: ProductType),
  status: String (Active/Inactive),
  isActive: Boolean,
  isDeleted: Boolean,
  createdBy: ObjectId (ref: User),
  updatedBy: ObjectId (ref: User),
  tenantId: String,
  createdAt: Date,
  updatedAt: Date
}
```

### Pricing Collection

```javascript
{
  _id: ObjectId,
  productId: ObjectId (ref: Product),
  currency: String,
  price: Number,
  effectiveFrom: Date,
  effectiveTo: Date (optional),
  status: String (Active/Inactive),
  isActive: Boolean,
  isDeleted: Boolean,
  createdBy: ObjectId (ref: User),
  updatedBy: ObjectId (ref: User),
  tenantId: String,
  createdAt: Date,
  updatedAt: Date
}
```
