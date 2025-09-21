# Lookup & LookupType Permission Setup Guide

## Overview

This guide helps you set up permissions for lookup and lookuptype resources in your staging environment, ensuring proper role-based access control.

## Prerequisites

1. **Environment Configuration**: Ensure your `.env.staging` file is properly configured
2. **Database Access**: MongoDB connection with proper credentials
3. **Admin Token**: Valid JWT token with admin privileges
4. **Server Running**: Your user-service should be running on the configured port

## Setup Methods

### Method 1: Direct Database Script (Recommended)

Use the `setup-lookup-permissions.js` script for direct database access:

```bash
# 1. Set your staging environment variables
export NODE_ENV=staging
export MONGO_URI="your-mongodb-connection-string"
export MONGO_USER="your-username"
export MONGO_PASS="your-password"
export MONGO_DB="user-service-staging"

# 2. Run the setup script
node setup-lookup-permissions.js
```

### Method 2: API-Based Script

Use the `create-lookup-permissions.js` script via API calls:

```bash
# 1. Set your API configuration
export API_BASE_URL="http://localhost:3001"
export ADMIN_TOKEN="your-admin-jwt-token"

# 2. Run the setup script
node create-lookup-permissions.js
```

## Created Permissions

The setup creates the following permissions:

### Lookup Permissions

| Code            | Name           | Description               | Level | Category |
| --------------- | -------------- | ------------------------- | ----- | -------- |
| `LOOKUP_READ`   | Read Lookups   | View lookup information   | 1     | GENERAL  |
| `LOOKUP_WRITE`  | Write Lookups  | Create and update lookups | 30    | GENERAL  |
| `LOOKUP_DELETE` | Delete Lookups | Delete lookups            | 60    | GENERAL  |

### LookupType Permissions

| Code                | Name                | Description                    | Level | Category |
| ------------------- | ------------------- | ------------------------------ | ----- | -------- |
| `LOOKUPTYPE_READ`   | Read Lookup Types   | View lookup type information   | 1     | GENERAL  |
| `LOOKUPTYPE_WRITE`  | Write Lookup Types  | Create and update lookup types | 30    | GENERAL  |
| `LOOKUPTYPE_DELETE` | Delete Lookup Types | Delete lookup types            | 60    | GENERAL  |

## Permission Assignment

### Automatic Assignment

- **Read permissions** (`LOOKUP_READ`, `LOOKUPTYPE_READ`) are automatically assigned to ALL active roles
- These permissions have level 1, making them accessible to all users

### Manual Assignment (Higher Levels)

- **Write permissions** (Level 30): Assign to roles with sufficient privileges
- **Delete permissions** (Level 60): Assign to high-privilege roles only

## Role Level Reference

Based on your role hierarchy:

| Level | Roles                                           | Access                                 |
| ----- | ----------------------------------------------- | -------------------------------------- |
| 1     | All roles                                       | Read access to lookups and lookuptypes |
| 30+   | IO, HLS, CC, ACC, RO, BO, IRO, IRE, MO, DAM, AM | Write access                           |
| 60+   | DIR, DPRS, ADIR, GS, DGS                        | Delete access                          |
| 95+   | ASU, SU                                         | Full system access                     |

## Testing the Setup

### 1. Test Read Access (All Roles)

```bash
curl -H "Authorization: Bearer <token>" \
     http://localhost:3001/api/lookups

curl -H "Authorization: Bearer <token>" \
     http://localhost:3001/api/lookuptypes
```

### 2. Test Write Access (Level 30+ Roles)

```bash
# Create a lookup
curl -X POST \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{
       "code": "TEST_LOOKUP",
       "lookupname": "Test Lookup",
       "lookuptypeId": "lookuptype_id",
       "userid": "user_id"
     }' \
     http://localhost:3001/api/lookups

# Create a lookup type
curl -X POST \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{
       "code": "TEST_TYPE",
       "lookuptype": "Test Lookup Type",
       "userid": "user_id"
     }' \
     http://localhost:3001/api/lookuptypes
```

### 3. Test Delete Access (Level 60+ Roles)

```bash
# Delete a lookup
curl -X DELETE \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"id": "lookup_id"}' \
     http://localhost:3001/api/lookups

# Delete a lookup type
curl -X DELETE \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"id": "lookuptype_id"}' \
     http://localhost:3001/api/lookuptypes
```

## Frontend Integration

### Permission Checks

```javascript
// Check permissions before showing UI elements
const canReadLookups = userPermissions.includes("LOOKUP_READ");
const canWriteLookups = userPermissions.includes("LOOKUP_WRITE");
const canDeleteLookups = userPermissions.includes("LOOKUP_DELETE");

const canReadLookupTypes = userPermissions.includes("LOOKUPTYPE_READ");
const canWriteLookupTypes = userPermissions.includes("LOOKUPTYPE_WRITE");
const canDeleteLookupTypes = userPermissions.includes("LOOKUPTYPE_DELETE");
```

### Conditional Rendering

```jsx
// React component example
function LookupManagement() {
  const { userPermissions } = useAuth();

  return (
    <div>
      {canReadLookups && <LookupList />}

      {canWriteLookups && <button onClick={createLookup}>Create Lookup</button>}

      {canDeleteLookups && <button onClick={deleteLookup}>Delete</button>}
    </div>
  );
}
```

## Troubleshooting

### Common Issues

1. **Authentication Failed**

   - Verify your MongoDB connection string
   - Check username/password credentials
   - Ensure database exists

2. **Permission Already Exists**

   - This is normal - the script skips existing permissions
   - Check if permissions were created successfully

3. **Role Validation Failed**

   - Ensure all roles have required fields (roleCategory, tenantId)
   - Check role schema requirements

4. **API Connection Issues**
   - Verify server is running
   - Check API_BASE_URL configuration
   - Validate admin token

### Verification Commands

```bash
# Check if permissions exist
curl -H "Authorization: Bearer <token>" \
     http://localhost:3001/api/permissions?resource=lookup

# Check role permissions
curl -H "Authorization: Bearer <token>" \
     http://localhost:3001/api/roles

# Test lookup endpoints
curl -H "Authorization: Bearer <token>" \
     http://localhost:3001/api/lookups
```

## Next Steps

1. **Test All Endpoints**: Verify read, write, and delete operations
2. **Update Frontend**: Implement permission-based UI controls
3. **Monitor Usage**: Track permission usage and adjust as needed
4. **Document Changes**: Update your API documentation

## Support

If you encounter issues:

1. Check the console logs for detailed error messages
2. Verify your environment configuration
3. Ensure all required dependencies are installed
4. Test with a simple API call first
