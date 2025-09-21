# PDP Integration Package for Other API Services

## 🎯 **Complete Package to Use User-Service as Policy Decision Point (PDP)**

This package contains everything you need to integrate other API services with the centralized RBAC system.

---

## 📦 **Files to Copy**

### **1. Core Policy Client**

Copy: `sdks/node-policy-client.js`

### **2. Environment Configuration**

Copy: `env.development.template` (relevant sections)

### **3. Integration Examples**

Copy: `examples/policy-client-usage-examples.js`

---

## 🔧 **1. Core Policy Client**

**File: `policy-client.js`**

```javascript
/**
 * Core Policy Client for Centralized RBAC Policy Evaluation
 * Framework-agnostic implementation that can be used across platforms
 *
 * Usage in Node.js/Express microservices:
 * const PolicyClient = require('./policy-client');
 * const policy = new PolicyClient('http://user-service:3000');
 */

class PolicyClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.timeout = options.timeout || 5000;
    this.retries = options.retries || 3;
    this.cache = new Map();
    this.cacheTimeout = options.cacheTimeout || 300000; // 5 minutes
  }

  /**
   * Evaluate a single authorization request
   * @param {string} token - JWT token
   * @param {string} resource - Resource being accessed
   * @param {string} action - Action being performed
   * @param {Object} context - Additional context
   * @returns {Promise<Object>} Policy decision
   */
  async evaluate(token, resource, action, context = {}) {
    const cacheKey = this.getCacheKey(token, resource, action, context);

    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.result;
      }
      this.cache.delete(cacheKey);
    }

    try {
      const response = await this.makeRequest("/policy/evaluate", {
        method: "POST",
        body: JSON.stringify({ token, resource, action, context }),
        headers: { "Content-Type": "application/json" },
      });

      // Cache successful results
      if (response.success) {
        this.cache.set(cacheKey, {
          result: response,
          timestamp: Date.now(),
        });
      }

      return response;
    } catch (error) {
      return {
        success: false,
        decision: "DENY",
        reason: "NETWORK_ERROR",
        error: error.message,
      };
    }
  }

  /**
   * Evaluate multiple authorization requests
   * @param {Array} requests - Array of {token, resource, action, context}
   * @returns {Promise<Array>} Array of policy decisions
   */
  async evaluateBatch(requests) {
    try {
      const response = await this.makeRequest("/policy/evaluate-batch", {
        method: "POST",
        body: JSON.stringify({ requests }),
        headers: { "Content-Type": "application/json" },
      });

      return response.results || [];
    } catch (error) {
      return requests.map(() => ({
        success: false,
        decision: "DENY",
        reason: "NETWORK_ERROR",
        error: error.message,
      }));
    }
  }

  /**
   * Get effective permissions for a resource
   * @param {string} token - JWT token
   * @param {string} resource - Resource name
   * @returns {Promise<Object>} Effective permissions
   */
  async getPermissions(token, resource) {
    try {
      const response = await this.makeRequest(
        `/policy/permissions/${resource}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      return response;
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Quick authorization check
   * @param {string} token - JWT token
   * @param {string} resource - Resource name
   * @param {string} action - Action name
   * @param {Object} context - Additional context
   * @returns {Promise<boolean>} Authorization result
   */
  async check(token, resource, action, context = {}) {
    try {
      const queryParams = new URLSearchParams(context);
      const response = await this.makeRequest(
        `/policy/check/${resource}/${action}?${queryParams}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      return response.success;
    } catch (error) {
      return false;
    }
  }

  /**
   * Middleware for Express.js applications
   * @param {string} resource - Resource name
   * @param {string} action - Action name
   * @returns {Function} Express middleware
   */
  middleware(resource, action) {
    return async (req, res, next) => {
      try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res.status(401).json({
            success: false,
            error: "Authorization header required",
          });
        }

        const token = authHeader.substring(7);
        const result = await this.evaluate(token, resource, action, req.query);

        if (result.success) {
          req.user = result.user;
          req.tenantId = result.user?.tenantId;
          next();
        } else {
          res.status(403).json({
            success: false,
            error: "Access denied",
            reason: result.reason,
          });
        }
      } catch (error) {
        res.status(500).json({
          success: false,
          error: "Authorization check failed",
        });
      }
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      timeout: this.cacheTimeout,
    };
  }

  /**
   * Make HTTP request with retry logic
   * @private
   */
  async makeRequest(endpoint, options) {
    const url = `${this.baseUrl}${endpoint}`;
    let lastError;

    for (let i = 0; i < this.retries; i++) {
      try {
        // Use fetch if available (Node 18+, browsers), otherwise use http/https modules
        if (typeof fetch !== "undefined") {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), this.timeout);

          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          return await response.json();
        } else {
          // Fallback for Node.js environments without fetch
          return await this.makeNodeRequest(url, options);
        }
      } catch (error) {
        lastError = error;
        if (i < this.retries - 1) {
          await this.delay(1000 * Math.pow(2, i)); // Exponential backoff
        }
      }
    }

    throw lastError;
  }

  /**
   * Node.js HTTP request fallback
   * @private
   */
  async makeNodeRequest(url, options) {
    return new Promise((resolve, reject) => {
      // Dynamic import to avoid issues in browser environments
      const urlModule = require("url");
      const parsedUrl = new urlModule.URL(url);
      const isHttps = parsedUrl.protocol === "https:";
      const httpModule = isHttps ? require("https") : require("http");

      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: this.timeout,
      };

      const req = httpModule.request(requestOptions, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          } catch (error) {
            reject(new Error("Invalid JSON response"));
          }
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (options.body) {
        req.write(options.body);
      }

      req.end();
    });
  }

  /**
   * Generate cache key
   * @private
   */
  getCacheKey(token, resource, action, context) {
    const tokenHash = this.hashToken(token);
    return `${tokenHash}:${resource}:${action}:${JSON.stringify(context)}`;
  }

  /**
   * Hash token for cache key (first 8 chars)
   * @private
   */
  hashToken(token) {
    return token.substring(0, 8);
  }

  /**
   * Delay utility
   * @private
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Support both CommonJS and ES modules
module.exports = PolicyClient;
module.exports.default = PolicyClient;
module.exports.PolicyClient = PolicyClient;

// For environments that support ES modules
if (typeof exports !== "undefined") {
  exports.default = PolicyClient;
  exports.PolicyClient = PolicyClient;
}
```

---

## 🔧 **2. Environment Configuration**

**File: `.env`**

```bash
# User Service PDP Configuration
USER_SERVICE_URL=http://user-service:3000
POLICY_SERVICE_TIMEOUT=5000
POLICY_SERVICE_RETRIES=3
POLICY_CACHE_TIMEOUT=300000

# Optional: Policy version for compatibility
POLICY_VERSION=1.0.0
```

---

## 🔧 **3. Express.js Integration**

**File: `middleware/policy.js`**

```javascript
const PolicyClient = require("../policy-client");

// Initialize policy client
const policyClient = new PolicyClient(process.env.USER_SERVICE_URL, {
  timeout: parseInt(process.env.POLICY_SERVICE_TIMEOUT) || 5000,
  retries: parseInt(process.env.POLICY_SERVICE_RETRIES) || 3,
  cacheTimeout: parseInt(process.env.POLICY_CACHE_TIMEOUT) || 300000,
});

/**
 * Policy middleware factory
 * @param {string} resource - Resource being protected
 * @param {string} action - Action being performed
 * @returns {Function} Express middleware
 */
const requirePolicy = (resource, action) => {
  return policyClient.middleware(resource, action);
};

/**
 * Custom policy middleware with additional context
 * @param {string} resource - Resource being protected
 * @param {string} action - Action being performed
 * @param {Function} contextExtractor - Function to extract additional context
 * @returns {Function} Express middleware
 */
const requirePolicyWithContext = (
  resource,
  action,
  contextExtractor = null
) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Authorization header required",
        });
      }

      const token = authHeader.substring(7);

      // Extract additional context if provided
      const additionalContext = contextExtractor ? contextExtractor(req) : {};

      const context = {
        ...req.query,
        ...req.body,
        ...additionalContext,
      };

      const result = await policyClient.evaluate(
        token,
        resource,
        action,
        context
      );

      if (result.success) {
        req.user = result.user;
        req.tenantId = result.user?.tenantId;
        req.policyContext = result;
        next();
      } else {
        res.status(403).json({
          success: false,
          error: "Access denied",
          reason: result.reason,
          user: result.user,
        });
      }
    } catch (error) {
      console.error("Policy middleware error:", error);
      res.status(500).json({
        success: false,
        error: "Authorization check failed",
      });
    }
  };
};

/**
 * Batch policy evaluation middleware
 * @param {Array} policies - Array of {resource, action, contextExtractor}
 * @returns {Function} Express middleware
 */
const requireBatchPolicy = (policies) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Authorization header required",
        });
      }

      const token = authHeader.substring(7);

      const requests = policies.map((policy) => ({
        token,
        resource: policy.resource,
        action: policy.action,
        context: policy.contextExtractor ? policy.contextExtractor(req) : {},
      }));

      const results = await policyClient.evaluateBatch(requests);

      // Check if all policies pass
      const allPassed = results.every((result) => result.success);

      if (allPassed) {
        req.user = results[0].user; // Use first result's user info
        req.tenantId = results[0].user?.tenantId;
        req.policyResults = results;
        next();
      } else {
        const failedPolicies = results.filter((result) => !result.success);
        res.status(403).json({
          success: false,
          error: "Access denied",
          failedPolicies,
        });
      }
    } catch (error) {
      console.error("Batch policy middleware error:", error);
      res.status(500).json({
        success: false,
        error: "Authorization check failed",
      });
    }
  };
};

module.exports = {
  policyClient,
  requirePolicy,
  requirePolicyWithContext,
  requireBatchPolicy,
};
```

---

## 🔧 **4. Usage Examples**

**File: `examples/usage-examples.js`**

```javascript
const PolicyClient = require("../policy-client");
const {
  requirePolicy,
  requirePolicyWithContext,
} = require("../middleware/policy");

// Initialize policy client
const policyClient = new PolicyClient(process.env.USER_SERVICE_URL);

// Example 1: Basic Express route protection
app.get("/api/users", requirePolicy("user", "read"), (req, res) => {
  // req.user contains user info from policy evaluation
  // req.tenantId contains tenant ID
  res.json({ users: [], tenantId: req.tenantId });
});

// Example 2: Route with custom context
app.post(
  "/api/users/:id",
  requirePolicyWithContext("user", "write", (req) => ({
    targetUserId: req.params.id,
    targetTenantId: req.body.tenantId,
  })),
  (req, res) => {
    res.json({ success: true });
  }
);

// Example 3: Programmatic policy evaluation
async function checkUserAccess(token, userId, tenantId) {
  const result = await policyClient.evaluate(token, "user", "read", {
    targetUserId: userId,
    targetTenantId: tenantId,
  });

  return result.success;
}

// Example 4: Batch policy evaluation
async function checkMultiplePermissions(token, permissions) {
  const requests = permissions.map((perm) => ({
    token,
    resource: perm.resource,
    action: perm.action,
    context: perm.context || {},
  }));

  const results = await policyClient.evaluateBatch(requests);
  return results;
}

// Example 5: Get user permissions for a resource
async function getUserPermissions(token, resource) {
  const result = await policyClient.getPermissions(token, resource);
  return result.success ? result.permissions : [];
}

// Example 6: Quick boolean check
async function hasPermission(token, resource, action) {
  return await policyClient.check(token, resource, action);
}

module.exports = {
  checkUserAccess,
  checkMultiplePermissions,
  getUserPermissions,
  hasPermission,
};
```

---

## 🔧 **5. Route Definitions**

**File: `routes/protected-routes.js`**

```javascript
const express = require("express");
const router = express.Router();
const {
  requirePolicy,
  requirePolicyWithContext,
} = require("../middleware/policy");

// User management routes
router.get("/users", requirePolicy("user", "read"), getUsers);
router.post("/users", requirePolicy("user", "write"), createUser);
router.put("/users/:id", requirePolicy("user", "write"), updateUser);
router.delete("/users/:id", requirePolicy("user", "delete"), deleteUser);

// Role management routes
router.get("/roles", requirePolicy("role", "read"), getRoles);
router.post("/roles", requirePolicy("role", "write"), createRole);
router.put("/roles/:id", requirePolicy("role", "write"), updateRole);
router.delete("/roles/:id", requirePolicy("role", "delete"), deleteRole);

// Lookup management routes
router.get("/lookups", requirePolicy("lookup", "read"), getLookups);
router.post("/lookups", requirePolicy("lookup", "write"), createLookup);
router.put("/lookups/:id", requirePolicy("lookup", "write"), updateLookup);
router.delete("/lookups/:id", requirePolicy("lookup", "delete"), deleteLookup);

// LookupType management routes
router.get(
  "/lookup-types",
  requirePolicy("lookupType", "read"),
  getLookupTypes
);
router.post(
  "/lookup-types",
  requirePolicy("lookupType", "write"),
  createLookupType
);
router.put(
  "/lookup-types/:id",
  requirePolicy("lookupType", "write"),
  updateLookupType
);
router.delete(
  "/lookup-types/:id",
  requirePolicy("lookupType", "delete"),
  deleteLookupType
);

// Admin routes
router.get("/admin/stats", requirePolicy("admin", "read"), getAdminStats);
router.post(
  "/admin/actions",
  requirePolicy("admin", "write"),
  performAdminAction
);

// Tenant-specific routes with context
router.get(
  "/tenant/:tenantId/users",
  requirePolicyWithContext("user", "read", (req) => ({
    targetTenantId: req.params.tenantId,
  })),
  getTenantUsers
);

module.exports = router;
```

---

## 🔧 **6. Error Handling**

**File: `middleware/error-handler.js`**

```javascript
/**
 * Policy-specific error handler
 */
const handlePolicyError = (error, req, res, next) => {
  if (error.name === "PolicyError") {
    return res.status(403).json({
      success: false,
      error: "Access denied",
      reason: error.reason,
      code: error.code,
    });
  }

  if (error.message.includes("Policy service")) {
    return res.status(503).json({
      success: false,
      error: "Policy service unavailable",
      code: "POLICY_SERVICE_DOWN",
    });
  }

  next(error);
};

/**
 * Custom error class for policy errors
 */
class PolicyError extends Error {
  constructor(message, reason, code) {
    super(message);
    this.name = "PolicyError";
    this.reason = reason;
    this.code = code;
  }
}

module.exports = {
  handlePolicyError,
  PolicyError,
};
```

---

## 🔧 **7. Testing Utilities**

**File: `test/policy-test-utils.js`**

```javascript
const PolicyClient = require("../policy-client");

/**
 * Mock policy client for testing
 */
class MockPolicyClient extends PolicyClient {
  constructor(mockResponses = {}) {
    super("http://mock-service");
    this.mockResponses = mockResponses;
  }

  async evaluate(token, resource, action, context = {}) {
    const key = `${resource}:${action}`;
    const mockResponse = this.mockResponses[key];

    if (mockResponse) {
      return typeof mockResponse === "function"
        ? mockResponse(token, resource, action, context)
        : mockResponse;
    }

    // Default mock response
    return {
      success: true,
      decision: "PERMIT",
      reason: "MOCK_PERMIT",
      user: {
        id: "test-user",
        tenantId: "test-tenant",
        roles: ["IO"],
        permissions: ["*"],
      },
      resource,
      action,
      timestamp: new Date().toISOString(),
    };
  }

  async evaluateBatch(requests) {
    return requests.map((request) =>
      this.evaluate(
        request.token,
        request.resource,
        request.action,
        request.context
      )
    );
  }
}

/**
 * Test helper to create mock responses
 */
const createMockResponses = (responses) => {
  return new MockPolicyClient(responses);
};

/**
 * Test helper for common scenarios
 */
const mockScenarios = {
  // Super user - can do everything
  superUser: {
    "user:read": {
      success: true,
      decision: "PERMIT",
      reason: "SUPER_USER_BYPASS",
    },
    "user:write": {
      success: true,
      decision: "PERMIT",
      reason: "SUPER_USER_BYPASS",
    },
    "user:delete": {
      success: true,
      decision: "PERMIT",
      reason: "SUPER_USER_BYPASS",
    },
    "role:read": {
      success: true,
      decision: "PERMIT",
      reason: "SUPER_USER_BYPASS",
    },
    "role:write": {
      success: true,
      decision: "PERMIT",
      reason: "SUPER_USER_BYPASS",
    },
    "role:delete": {
      success: true,
      decision: "PERMIT",
      reason: "SUPER_USER_BYPASS",
    },
  },

  // Regular user - limited access
  regularUser: {
    "user:read": {
      success: true,
      decision: "PERMIT",
      reason: "POLICY_SATISFIED",
    },
    "user:write": {
      success: false,
      decision: "DENY",
      reason: "INSUFFICIENT_ROLE_LEVEL",
    },
    "user:delete": {
      success: false,
      decision: "DENY",
      reason: "INSUFFICIENT_ROLE_LEVEL",
    },
    "role:read": {
      success: true,
      decision: "PERMIT",
      reason: "POLICY_SATISFIED",
    },
    "role:write": {
      success: false,
      decision: "DENY",
      reason: "INSUFFICIENT_ROLE_LEVEL",
    },
    "role:delete": {
      success: false,
      decision: "DENY",
      reason: "INSUFFICIENT_ROLE_LEVEL",
    },
  },

  // No access
  noAccess: {
    "user:read": {
      success: false,
      decision: "DENY",
      reason: "INVALID_USER_TYPE",
    },
    "user:write": {
      success: false,
      decision: "DENY",
      reason: "INVALID_USER_TYPE",
    },
    "user:delete": {
      success: false,
      decision: "DENY",
      reason: "INVALID_USER_TYPE",
    },
    "role:read": {
      success: false,
      decision: "DENY",
      reason: "INVALID_USER_TYPE",
    },
    "role:write": {
      success: false,
      decision: "DENY",
      reason: "INVALID_USER_TYPE",
    },
    "role:delete": {
      success: false,
      decision: "DENY",
      reason: "INVALID_USER_TYPE",
    },
  },
};

module.exports = {
  MockPolicyClient,
  createMockResponses,
  mockScenarios,
};
```

---

## 🔧 **8. Package.json Dependencies**

**Add to your `package.json`:**

```json
{
  "dependencies": {
    "express": "^4.18.0"
  },
  "devDependencies": {
    "jest": "^29.0.0",
    "supertest": "^6.0.0"
  }
}
```

---

## 🔧 **9. Integration Checklist**

### **Step 1: Copy Files**

- [ ] Copy `policy-client.js` to your service
- [ ] Copy `middleware/policy.js` to your service
- [ ] Copy `middleware/error-handler.js` to your service
- [ ] Copy `test/policy-test-utils.js` to your service

### **Step 2: Environment Setup**

- [ ] Add environment variables to `.env`
- [ ] Update `package.json` dependencies
- [ ] Configure user-service URL

### **Step 3: Integration**

- [ ] Import policy middleware in your routes
- [ ] Add policy protection to existing routes
- [ ] Update error handling
- [ ] Add tests

### **Step 4: Testing**

- [ ] Test with mock policy client
- [ ] Test with real user-service
- [ ] Test error scenarios
- [ ] Test performance

---

## 🔧 **10. API Endpoints Reference**

### **Policy Evaluation Endpoints**

- `POST /policy/evaluate` - Single policy evaluation
- `POST /policy/evaluate-batch` - Batch policy evaluation
- `GET /policy/permissions/:resource` - Get user permissions for resource
- `GET /policy/check/:resource/:action` - Quick authorization check
- `GET /policy/health` - Health check
- `GET /policy/info` - Policy information

### **Cache Management Endpoints** (Super User only)

- `POST /api/cache/clear` - Clear all caches
- `POST /api/cache/refresh/role-hierarchy` - Refresh role hierarchy cache
- `POST /api/cache/refresh/permissions` - Refresh permissions cache

---

## 🔧 **11. Supported Resources & Actions**

### **Resources**

- `portal` - Portal application access
- `crm` - CRM application access
- `admin` - Admin panel access
- `api` - API endpoints access
- `user` - User management access
- `role` - Role management access
- `lookup` - Lookup data access
- `lookupType` - Lookup type management access
- `permission` - Permission management access
- `tenant` - Tenant management access

### **Actions**

- `read` - View data (min role level: 1)
- `write` - Create/update data (min role level: 30)
- `update` - Update data (min role level: 30)
- `delete` - Delete data (min role level: 60)
- `admin` - Administrative actions (min role level: 80)
- `super_admin` - Super user actions (min role level: 100)

---

## 🔧 **12. Troubleshooting**

### **Common Issues**

1. **Policy service unavailable**

   - Check `USER_SERVICE_URL` environment variable
   - Verify user-service is running
   - Check network connectivity

2. **Token validation errors**

   - Ensure JWT token is valid
   - Check token contains `tenantId` field
   - Verify token hasn't expired

3. **Permission denied errors**

   - Check user roles and permissions
   - Verify resource/action combinations
   - Check tenant isolation rules

4. **Cache issues**
   - Clear policy cache if needed
   - Check Redis connectivity
   - Verify cache TTL settings

### **Debug Mode**

Set `DEBUG=true` in environment to enable detailed logging.

---

## 🎯 **Quick Start**

1. **Copy the files** from this package
2. **Set environment variables**
3. **Add middleware to routes**:
   ```javascript
   app.get("/api/users", requirePolicy("user", "read"), getUsers);
   ```
4. **Test with mock client** first
5. **Deploy with real user-service**

This package provides everything needed to integrate any API service with the centralized RBAC system!
