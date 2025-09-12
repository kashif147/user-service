# Centralized RBAC Policy Evaluation System

A comprehensive Role-Based Access Control (RBAC) system that centralizes authorization logic and removes it from individual services, supporting mobile apps, web applications, and microservices.

## 🏗️ Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Mobile App    │    │   Web Apps      │    │ Microservices  │
│  (React Native) │    │ (Portal & CRM)  │    │  (Node.js)     │
└─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                    ┌─────────────▼─────────────┐
                    │   Policy Evaluation API   │
                    │   (Policy Decision Point) │
                    └─────────────┬─────────────┘
                                 │
                    ┌─────────────▼─────────────┐
                    │     Redis Cache Layer     │
                    │   (Performance Boost)     │
                    └───────────────────────────┘
```

## 🚀 Features

- **Centralized Authorization**: Single source of truth for all authorization decisions
- **Multi-Platform Support**: SDKs for Node.js, React, and React Native
- **High Performance**: Redis caching with local fallback
- **Offline Support**: Mobile apps can work with cached permissions
- **Batch Evaluation**: Check multiple permissions in one request
- **Real-time Updates**: Cache invalidation and policy updates
- **Comprehensive Logging**: Audit trail for all authorization decisions

## 📡 API Endpoints

### Core Policy Evaluation

| Method | Endpoint                          | Description                           |
| ------ | --------------------------------- | ------------------------------------- |
| `POST` | `/policy/evaluate`                | Evaluate single authorization request |
| `POST` | `/policy/evaluate-batch`          | Evaluate multiple requests            |
| `GET`  | `/policy/check/:resource/:action` | Quick authorization check             |
| `GET`  | `/policy/permissions/:resource`   | Get user's effective permissions      |

### Cache Management

| Method   | Endpoint              | Description                |
| -------- | --------------------- | -------------------------- |
| `GET`    | `/policy/cache/stats` | Get cache statistics       |
| `DELETE` | `/policy/cache`       | Clear all cache            |
| `DELETE` | `/policy/cache/:key`  | Clear specific cache entry |

### Information

| Method | Endpoint         | Description                         |
| ------ | ---------------- | ----------------------------------- |
| `GET`  | `/policy/info`   | Get available resources and actions |
| `GET`  | `/policy/health` | Health check                        |

## 🔧 Installation & Setup

### 1. Environment Variables

Add these to your `.env` files:

```bash
# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_DB=0
REDIS_ENABLED=true

# Policy Cache Configuration
POLICY_CACHE_TTL=300  # 5 minutes

# JWT Configuration
JWT_SECRET=your_jwt_secret
JWT_EXPIRY=24h
```

### 2. Install Dependencies

```bash
npm install redis jsonwebtoken
```

### 3. Start Redis Server

```bash
# Using Docker
docker run -d -p 6379:6379 redis:alpine

# Or install locally
redis-server
```

## 📱 Client SDKs

### Node.js/Express Microservices

```javascript
const PolicyClient = require("./sdks/node-policy-client");

const policy = new PolicyClient("http://user-service:3000");

// Express middleware
app.get("/api/users", policy.middleware("user", "read"), (req, res) => {
  res.json({ users: [] });
});

// Manual evaluation
const result = await policy.evaluate(token, "user", "read");
if (result.success) {
  // Allow access
}
```

### React Web Applications

```javascript
import PolicyClient from "./sdks/react-policy-client";

const policy = new PolicyClient("http://user-service:3000");

// React Hook
function UserProfile({ token }) {
  const { loading, authorized } = policy.useAuthorization(
    token,
    "user",
    "read"
  );

  if (loading) return <div>Loading...</div>;
  if (!authorized) return <div>Access denied</div>;

  return <div>User Profile</div>;
}

// Conditional rendering
<policy.AuthorizedComponent token={token} resource="admin" action="read">
  <AdminPanel />
</policy.AuthorizedComponent>;
```

### React Native Mobile Apps

```javascript
import PolicyClient from "./sdks/react-native-policy-client";

const policy = new PolicyClient("http://user-service:3000", {
  enableOfflineCache: true,
  cacheTimeout: 600000, // 10 minutes
});

// Mobile-specific hook
function MobileUserProfile({ token }) {
  const { loading, authorized, cached } = policy.useAuthorization(
    token,
    "user",
    "read"
  );

  return (
    <View>
      {cached && <Text>Using cached data</Text>}
      {authorized && <Text>User Profile</Text>}
    </View>
  );
}

// Preload permissions for offline use
await policy.preloadPermissions(token, ["user", "portal", "crm"]);
```

## 🔐 Policy Configuration

### Resource Access Matrix

```javascript
const resourceAccessMatrix = {
  portal: {
    allowedUserTypes: ["CRM", "MEMBER"],
    allowedRoles: ["*"], // All roles
  },
  crm: {
    allowedUserTypes: ["CRM"],
    allowedRoles: [
      "SU",
      "GS",
      "DGS",
      "DIR",
      "DPRS",
      "ADIR",
      "AM",
      "DAM",
      "MO",
      "AMO",
    ],
  },
  admin: {
    allowedUserTypes: ["CRM"],
    allowedRoles: ["SU", "GS", "DGS"],
  },
};
```

### Action Requirements

```javascript
const actionRequirements = {
  read: { minRoleLevel: 1 }, // Any authenticated user
  write: { minRoleLevel: 30 }, // IO level and above
  delete: { minRoleLevel: 60 }, // MO level and above
  admin: { minRoleLevel: 80 }, // DIR level and above
  super_admin: { minRoleLevel: 100 }, // SU only
};
```

## 📊 Usage Examples

### 1. Single Authorization Check

```bash
curl -X POST http://user-service:3000/policy/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "resource": "crm",
    "action": "read"
  }'
```

**Response:**

```json
{
  "success": true,
  "decision": "PERMIT",
  "reason": "POLICY_SATISFIED",
  "user": {
    "id": "68a74baafd197e52c818db4f",
    "tenantId": "39866a06-30bc-4a89-80c6-9dd9357dd453",
    "userType": "CRM",
    "roles": [{ "code": "SU", "name": "Super User" }],
    "permissions": ["*"]
  },
  "resource": "crm",
  "action": "read",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 2. Batch Evaluation

```bash
curl -X POST http://user-service:3000/policy/evaluate-batch \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {"token": "token1", "resource": "user", "action": "read"},
      {"token": "token1", "resource": "user", "action": "write"},
      {"token": "token1", "resource": "role", "action": "read"}
    ]
  }'
```

### 3. Get Effective Permissions

```bash
curl -X GET http://user-service:3000/policy/permissions/user \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Response:**

```json
{
  "success": true,
  "resource": "user",
  "permissions": ["user:read", "user:write", "user:delete"],
  "roles": [{ "code": "SU", "name": "Super User" }],
  "userType": "CRM",
  "tenantId": "39866a06-30bc-4a89-80c6-9dd9357dd453"
}
```

## 🚀 Performance Optimization

### Caching Strategy

- **Redis Cache**: Primary cache for high performance
- **Local Cache**: Fallback when Redis is unavailable
- **Negative Caching**: Cache denied requests for shorter time
- **Cache Invalidation**: Automatic cleanup of expired entries

### Cache Configuration

```javascript
const cache = new PolicyCache({
  enabled: true,
  ttl: 300, // 5 minutes
  prefix: "policy:", // Redis key prefix
  localCacheSize: 1000,
  localCacheTimeout: 60000, // 1 minute
});
```

## 🔍 Monitoring & Debugging

### Cache Statistics

```bash
curl -X GET http://user-service:3000/policy/cache/stats
```

**Response:**

```json
{
  "success": true,
  "stats": {
    "enabled": true,
    "redisConnected": true,
    "localCacheSize": 45,
    "ttl": 300,
    "redisMemory": "used_memory:1234567"
  }
}
```

### Health Check

```bash
curl -X GET http://user-service:3000/policy/health
```

## 🛡️ Security Considerations

1. **Token Validation**: All tokens are validated against JWT_SECRET
2. **Tenant Isolation**: Multi-tenant support with tenant context validation
3. **Role Hierarchy**: Enforced minimum role levels for actions
4. **Permission Granularity**: Fine-grained permission checking
5. **Audit Trail**: All authorization decisions are logged

## 🔄 Migration Guide

### From Existing Auth Middleware

**Before:**

```javascript
app.use("/api", authenticate, requireRole(["SU"]));
```

**After:**

```javascript
app.use("/api", policy.middleware("api", "read"));
```

### From Manual Permission Checks

**Before:**

```javascript
if (user.roles.includes("SU") || user.permissions.includes("user:write")) {
  // Allow access
}
```

**After:**

```javascript
const result = await policy.evaluate(token, "user", "write");
if (result.success) {
  // Allow access
}
```

## 📈 Benefits

- **Centralized Logic**: Single place to update authorization rules
- **Consistent Behavior**: Same authorization logic across all platforms
- **Performance**: Redis caching reduces database queries
- **Scalability**: Handles high-volume authorization requests
- **Maintainability**: Easy to update policies without code changes
- **Audit Compliance**: Complete audit trail of authorization decisions

## 🆘 Troubleshooting

### Common Issues

1. **Redis Connection Failed**

   - Check Redis server is running
   - Verify connection settings in environment variables

2. **Token Validation Errors**

   - Ensure JWT_SECRET matches across services
   - Check token expiration

3. **Cache Misses**
   - Verify cache TTL settings
   - Check Redis memory usage

### Debug Mode

Enable debug logging by setting:

```bash
LOG_LEVEL=debug
```

This will log all policy evaluation decisions and cache operations.

## 📚 Additional Resources

- [Policy Evaluation Service](./services/policyEvaluationService.js)
- [Client SDKs](./sdks/)
- [Usage Examples](./examples/policy-usage-examples.js)
- [Cache Implementation](./services/policyCache.js)
