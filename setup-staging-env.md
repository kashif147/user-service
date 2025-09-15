# Staging Environment Setup Guide

## 1. Environment Configuration

Create a `.env.staging` file in the project root with the following configuration:

```bash
# Staging Environment Configuration
NODE_ENV=staging
PORT=3001

# MongoDB Configuration
MONGO_URI=mongodb+srv://your-username:your-password@clusterprojectshell.tptnh8w.mongodb.net/user-service-staging?retryWrites=true&w=majority&appName=ClusterProjectShell
MONGO_USER=your-username
MONGO_PASS=your-password
MONGO_DB=user-service-staging

# JWT Configuration
JWT_SECRET=your-staging-jwt-secret-key
JWT_EXPIRES_IN=24h
JWT_REFRESH_EXPIRES_IN=7d

# Azure AD B2C Configuration
AZURE_AD_B2C_TENANT_ID=your-tenant-id
AZURE_AD_B2C_CLIENT_ID=your-client-id
AZURE_AD_B2C_CLIENT_SECRET=your-client-secret
AZURE_AD_B2C_POLICY_NAME=B2C_1_signupsignin
AZURE_AD_B2C_SCOPE=https://your-tenant.onmicrosoft.com/api/read

# Redis Configuration (if used)
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=

# API Configuration
API_BASE_URL=https://api-staging.yourdomain.com
FRONTEND_URL=https://staging.yourdomain.com

# Logging
LOG_LEVEL=info
LOG_FILE=logs/staging.log

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

## 2. Run Permission Setup Script

Execute the permission setup script to create lookup and lookuptype permissions:

```bash
# Make the script executable
chmod +x setup-lookup-permissions.js

# Run the setup script
node setup-lookup-permissions.js
```

## 3. Verify Setup

After running the script, you should see:

- ✅ Connected to MongoDB
- ✅ Created permissions for lookup and lookuptype
- ✅ Found main tenant
- ✅ Assigned read permissions to all roles
- 📋 Permission summary

## 4. Created Permissions

The script creates the following permissions:

### Lookup Permissions:

- `LOOKUP_READ`: View lookup information (Level 1)
- `LOOKUP_WRITE`: Create and update lookups (Level 30)
- `LOOKUP_DELETE`: Delete lookups (Level 60)

### LookupType Permissions:

- `LOOKUPTYPE_READ`: View lookup type information (Level 1)
- `LOOKUPTYPE_WRITE`: Create and update lookup types (Level 30)
- `LOOKUPTYPE_DELETE`: Delete lookup types (Level 60)

## 5. Permission Assignment

- **Read permissions** are automatically assigned to ALL active roles
- **Write permissions** require role level 30 or higher
- **Delete permissions** require role level 60 or higher

## 6. Role Level Reference

Based on your role hierarchy:

- Level 1: All roles (Read access)
- Level 30+: IO, HLS, CC, ACC and above (Write access)
- Level 60+: DIR, DPRS, ADIR and above (Delete access)

## 7. Testing

Test the endpoints with different role levels:

```bash
# Test read access (should work for all roles)
curl -H "Authorization: Bearer <token>" \
     http://localhost:3001/api/lookups

# Test write access (should work for level 30+ roles)
curl -X POST \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"code":"TEST","lookupname":"Test Lookup","userid":"user_id"}' \
     http://localhost:3001/api/lookups
```

## 8. Frontend Integration

Update your frontend to check for permissions:

```javascript
// Check if user can read lookups
const canReadLookups = userPermissions.includes("LOOKUP_READ");

// Check if user can write lookups
const canWriteLookups = userPermissions.includes("LOOKUP_WRITE");

// Check if user can delete lookups
const canDeleteLookups = userPermissions.includes("LOOKUP_DELETE");
```
