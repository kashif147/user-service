# Implementation Guide for API Developers

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install redis jsonwebtoken
```

### 2. Copy SDK to Your Service

```bash
# Copy the Node.js SDK to your microservice
cp /path/to/user-service/sdks/node-policy-client.js ./policy-client.js
```

### 3. Environment Variables

Add to your `.env` file:

```bash
# Policy Service Configuration
POLICY_SERVICE_URL=http://user-service:3000
POLICY_CACHE_TIMEOUT=300000  # 5 minutes
POLICY_RETRIES=3
POLICY_TIMEOUT=5000
```

## 🔧 Implementation Steps

### Step 1: Initialize Policy Client

```javascript
const PolicyClient = require("./policy-client");

const policy = new PolicyClient(process.env.POLICY_SERVICE_URL, {
  timeout: process.env.POLICY_TIMEOUT || 5000,
  retries: process.env.POLICY_RETRIES || 3,
  cacheTimeout: process.env.POLICY_CACHE_TIMEOUT || 300000,
});
```

### Step 2: Replace Existing Auth Middleware

**Before (Old Way):**

```javascript
const {
  authenticate,
  requireRole,
} = require("@membership/user-service/middlewares/auth");

app.use("/api/users", authenticate, requireRole(["SU"]), userController.getAll);
```

**After (New Way):**

```javascript
app.use("/api/users", policy.middleware("user", "read"), userController.getAll);
```

### Step 3: Update Route Protection

**Before:**

```javascript
app.get("/api/users/:id", authenticate, (req, res) => {
  // Manual permission check
  if (
    !req.user.roles.includes("SU") &&
    !req.user.permissions.includes("user:read")
  ) {
    return res.status(403).json({ error: "Access denied" });
  }
  // Handle request
});
```

**After:**

```javascript
app.get("/api/users/:id", policy.middleware("user", "read"), (req, res) => {
  // req.user and req.tenantId are automatically available
  // Handle request
});
```

### Step 4: Manual Authorization Checks

**Before:**

```javascript
async function updateUser(req, res) {
  const token = req.headers.authorization?.substring(7);

  // Manual role/permission checking
  const user = await validateToken(token);
  if (!user.roles.includes("SU") && !user.permissions.includes("user:write")) {
    return res.status(403).json({ error: "Access denied" });
  }

  // Update user
}
```

**After:**

```javascript
async function updateUser(req, res) {
  const token = req.headers.authorization?.substring(7);

  const result = await policy.evaluate(token, "user", "write");
  if (!result.success) {
    return res.status(403).json({
      error: "Access denied",
      reason: result.reason,
    });
  }

  // result.user contains user info
  // Update user
}
```

## 📋 Common Patterns

### 1. Resource-Based Protection

```javascript
// Protect by resource and action
app.get("/api/users", policy.middleware("user", "read"), getUsers);
app.post("/api/users", policy.middleware("user", "write"), createUser);
app.put("/api/users/:id", policy.middleware("user", "write"), updateUser);
app.delete("/api/users/:id", policy.middleware("user", "delete"), deleteUser);
```

### 2. Batch Permission Checks

```javascript
async function getUserDashboard(req, res) {
  const token = req.headers.authorization?.substring(7);

  const requests = [
    { token, resource: "user", action: "read" },
    { token, resource: "role", action: "read" },
    { token, resource: "account", action: "read" },
  ];

  const results = await policy.evaluateBatch(requests);

  const permissions = {
    canReadUsers: results[0].success,
    canReadRoles: results[1].success,
    canReadAccounts: results[2].success,
  };

  res.json({ permissions });
}
```

### 3. Tenant Isolation

```javascript
app.use("/api", policy.middleware("api", "read"), (req, res, next) => {
  // req.tenantId is automatically set by policy middleware
  // Use it for database queries
  req.dbQuery = { ...req.dbQuery, tenantId: req.tenantId };
  next();
});
```

## 🔄 Migration Checklist

- [ ] Install dependencies (`redis`, `jsonwebtoken`)
- [ ] Copy `node-policy-client.js` to your service
- [ ] Add environment variables
- [ ] Initialize PolicyClient
- [ ] Replace `authenticate` middleware with `policy.middleware()`
- [ ] Replace manual role checks with `policy.evaluate()`
- [ ] Update error handling for policy responses
- [ ] Test all protected endpoints
- [ ] Remove old auth middleware imports

## 🧪 Testing

### Test Policy Evaluation

```javascript
// Test script
const policy = new PolicyClient("http://user-service:3000");

async function testPolicy() {
  const token = "your-jwt-token";

  const result = await policy.evaluate(token, "user", "read");
  console.log("Policy result:", result);

  if (result.success) {
    console.log("User:", result.user);
    console.log("Tenant:", result.user.tenantId);
  }
}

testPolicy();
```

### Test Middleware

```javascript
// Test middleware
app.get("/test", policy.middleware("user", "read"), (req, res) => {
  res.json({
    message: "Access granted",
    user: req.user,
    tenantId: req.tenantId,
  });
});
```

## 🚨 Error Handling

### Common Error Responses

```javascript
// Handle policy evaluation errors
try {
  const result = await policy.evaluate(token, "user", "read");

  if (!result.success) {
    switch (result.reason) {
      case "INVALID_TOKEN":
        return res.status(401).json({ error: "Invalid token" });
      case "MISSING_TENANT_CONTEXT":
        return res.status(400).json({ error: "Missing tenant context" });
      case "INSUFFICIENT_ROLE":
        return res.status(403).json({ error: "Insufficient role" });
      case "MISSING_PERMISSION":
        return res.status(403).json({ error: "Missing permission" });
      default:
        return res.status(403).json({ error: "Access denied" });
    }
  }
} catch (error) {
  return res.status(500).json({ error: "Policy evaluation failed" });
}
```

## 📊 Monitoring

### Cache Statistics

```javascript
// Check cache performance
app.get("/admin/cache-stats", async (req, res) => {
  const stats = policy.getCacheStats();
  res.json(stats);
});
```

### Health Check

```javascript
// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    // Test policy service connectivity
    const response = await fetch(
      `${process.env.POLICY_SERVICE_URL}/policy/health`
    );
    const health = await response.json();

    res.json({
      status: "healthy",
      policyService: health.status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: error.message,
    });
  }
});
```

## 🔧 Configuration Examples

### Development Environment

```bash
POLICY_SERVICE_URL=http://localhost:3000
POLICY_CACHE_TIMEOUT=60000  # 1 minute for dev
POLICY_RETRIES=1
POLICY_TIMEOUT=3000
```

### Production Environment

```bash
POLICY_SERVICE_URL=http://user-service:3000
POLICY_CACHE_TIMEOUT=300000  # 5 minutes
POLICY_RETRIES=3
POLICY_TIMEOUT=5000
```

## 📞 Support

If you encounter issues:

1. Check the policy service is running: `GET /policy/health`
2. Verify your JWT token is valid
3. Check cache statistics: `GET /policy/cache/stats`
4. Review error logs for policy evaluation failures

## 🎯 Benefits You'll Get

- **Simplified Code**: No more complex role/permission logic
- **Consistent Security**: Same authorization across all services
- **Better Performance**: Cached policy decisions
- **Easy Maintenance**: Update policies without code changes
- **Audit Trail**: Complete logging of authorization decisions
