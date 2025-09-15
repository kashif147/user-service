# Lookup & LookupType API Endpoints

## Base URL

```
/api/lookups
/api/lookuptypes
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

## Lookup Endpoints

### 1. Get All Lookups

**GET** `/api/lookups`

**Response:**

```json
[
  {
    "_id": "lookup_id",
    "code": "LOOKUP_CODE",
    "lookupname": "Lookup Name",
    "DisplayName": "Display Name",
    "Parentlookupid": "parent_lookup_id",
    "Parentlookup": "Parent Lookup Name",
    "lookuptypeId": {
      "_id": "lookuptype_id",
      "code": "LOOKUPTYPE_CODE",
      "lookuptype": "LookupType Name"
    },
    "isactive": true,
    "isdeleted": false
  }
]
```

### 2. Get Single Lookup

**GET** `/api/lookups/:id`

**Response:** Same as above (single object)

### 3. Create New Lookup

**POST** `/api/lookups`
**Required Roles:** SU, ASU

**Request Body:**

```json
{
  "code": "NEW_LOOKUP_CODE",
  "lookupname": "New Lookup Name",
  "DisplayName": "New Display Name",
  "Parentlookupid": "parent_lookup_id",
  "lookuptypeId": "lookuptype_id",
  "isdeleted": false,
  "isactive": true,
  "userid": "user_id"
}
```

**Required Fields:** `code`, `lookupname`, `userid`

### 4. Update Lookup

**PUT** `/api/lookups`
**Required Roles:** SU, ASU

**Request Body:**

```json
{
  "id": "lookup_id",
  "code": "UPDATED_CODE",
  "lookupname": "Updated Name",
  "DisplayName": "Updated Display Name",
  "Parentlookupid": "new_parent_id",
  "lookuptypeId": "new_lookuptype_id",
  "isdeleted": false,
  "isactive": true,
  "userid": "user_id"
}
```

### 5. Delete Lookup

**DELETE** `/api/lookups`
**Required Roles:** SU

**Request Body:**

```json
{
  "id": "lookup_id"
}
```

---

## LookupType Endpoints

### 1. Get All Lookup Types

**GET** `/api/lookuptypes`

**Response:**

```json
[
  {
    "_id": "lookuptype_id",
    "code": "LOOKUPTYPE_CODE",
    "lookuptype": "LookupType Name",
    "displayname": "Display Name",
    "isdeleted": false,
    "isactive": true,
    "userid": "user_id",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
]
```

### 2. Get Single Lookup Type

**GET** `/api/lookuptypes/:id`

**Response:** Same as above (single object)

### 3. Create New Lookup Type

**POST** `/api/lookuptypes`
**Required Roles:** SU, ASU

**Request Body:**

```json
{
  "code": "NEW_LOOKUPTYPE_CODE",
  "lookuptype": "New LookupType Name",
  "DisplayName": "New Display Name",
  "isdeleted": false,
  "isactive": true,
  "userid": "user_id"
}
```

**Required Fields:** `code`, `lookuptype`, `userid`

### 4. Update Lookup Type

**PUT** `/api/lookuptypes`
**Required Roles:** SU, ASU

**Request Body:**

```json
{
  "id": "lookuptype_id",
  "code": "UPDATED_CODE",
  "lookuptype": "Updated Name",
  "displayname": "Updated Display Name",
  "isdeleted": false,
  "isactive": true,
  "userid": "user_id"
}
```

### 5. Delete Lookup Type

**DELETE** `/api/lookuptypes`
**Required Roles:** SU

**Request Body:**

```json
{
  "id": "lookuptype_id"
}
```

---

## Error Responses

### 400 Bad Request

```json
{
  "error": "Code, Lookup, User ID are required"
}
```

### 401 Unauthorized

```json
{
  "message": "Unauthorized"
}
```

### 403 Forbidden

```json
{
  "message": "Forbidden: Insufficient privileges"
}
```

### 404 Not Found

```json
{
  "error": "Lookup not found"
}
```

### 409 Conflict

```json
{
  "error": "Code must be unique"
}
```

### 500 Internal Server Error

```json
{
  "error": "Server error"
}
```

---

## Frontend Integration Examples

### React/Next.js Example

```javascript
// Fetch all lookups
const fetchLookups = async () => {
  const response = await fetch("/api/lookups", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return response.json();
};

// Create new lookup
const createLookup = async (lookupData) => {
  const response = await fetch("/api/lookups", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(lookupData),
  });
  return response.json();
};
```

### React Native Example

```javascript
import AsyncStorage from "@react-native-async-storage/async-storage";

const API_BASE = "https://your-api-domain.com";

const fetchLookups = async () => {
  const token = await AsyncStorage.getItem("authToken");
  const response = await fetch(`${API_BASE}/api/lookups`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return response.json();
};
```

---

## Data Validation Rules

### Lookup Model

- `code`: Required, unique, max 10 characters
- `lookupname`: Required, max 100 characters
- `DisplayName`: Optional, max 100 characters
- `Parentlookupid`: Optional, must be valid ObjectId
- `lookuptypeId`: Required, must be valid ObjectId
- `userid`: Required, must be valid ObjectId

### LookupType Model

- `code`: Required, unique, 3-10 characters, uppercase
- `lookuptype`: Required, 3-50 characters
- `displayname`: Optional, 3-50 characters
- `userid`: Required, must be valid ObjectId

---

## Usage Notes

1. **Hierarchical Structure**: Lookups can have parent-child relationships via `Parentlookupid`
2. **Soft Delete**: Use `isdeleted` flag instead of hard deletion
3. **Active Status**: Use `isactive` flag to control visibility
4. **Audit Trail**: All operations include user tracking via `userid`
5. **Timestamps**: Automatic `createdAt` and `updatedAt` timestamps
