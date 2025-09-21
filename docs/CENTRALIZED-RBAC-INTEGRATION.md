# Centralized RBAC Integration Guide

## 🎯 **How Other Services & Applications Use Your Centralized RBAC**

Your user-service acts as the **Policy Decision Point (PDP)** for all authorization across your entire ecosystem. Here's how different services and applications integrate with it.

---

## 🏗️ **Architecture Overview**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   React.js App  │    │  React Native   │    │  Other Services │
│   (CRM/Portal)  │    │     App         │    │ (Microservices) │
└─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘
          │                      │                      │
          │     HTTP Requests    │                      │
          │  ┌─────────────────────────────────────────┐ │
          └──▶│        User Service (RBAC PDP)        │◀┘
              │  ┌─────────────────────────────────┐   │
              │  │    Policy Evaluation Service    │   │
              │  │  • Role-based authorization    │   │
              │  │  • Permission-based auth       │   │
              │  │  • Tenant isolation           │   │
              │  │  • Policy caching             │   │
              │  └─────────────────────────────────┘   │
              └─────────────────────────────────────────┘
```

---

## 🔌 **Integration Methods**

### **Method 1: Direct API Calls (Recommended)**

All clients make HTTP requests to your user-service for authorization decisions.

#### **API Endpoints Available:**

**1. Single Policy Evaluation**

```http
POST /policy/evaluate
Content-Type: application/json

{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "resource": "crm",
  "action": "write",
  "context": {
    "userId": "user123",
    "tenantId": "tenant456"
  }
}
```

**Response:**

```json
{
  "success": true,
  "decision": "PERMIT",
  "reason": "POLICY_SATISFIED",
  "user": {
    "id": "user123",
    "roles": ["GS", "DIR"],
    "permissions": ["user:read", "user:write"]
  },
  "resource": "crm",
  "action": "write",
  "timestamp": "2024-01-15T10:30:00Z",
  "expiresAt": "2024-01-15T10:35:00Z"
}
```

**2. Batch Policy Evaluation**

```http
POST /policy/evaluate-batch
Content-Type: application/json

{
  "requests": [
    {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "resource": "user",
      "action": "read"
    },
    {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "resource": "role",
      "action": "write"
    }
  ]
}
```

**3. Get User Permissions**

```http
GET /policy/permissions/user?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**4. Policy Information**

```http
GET /policy/info
```

---

## 📱 **React.js Integration**

### **Step 1: Create Policy Client**

```javascript
// utils/policyClient.js
class PolicyClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
  }

  async evaluatePolicy(token, resource, action, context = {}) {
    const cacheKey = `${token.substring(0, 8)}:${resource}:${action}`;

    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.result;
      }
    }

    try {
      const response = await fetch(`${this.baseURL}/policy/evaluate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          token,
          resource,
          action,
          context,
        }),
      });

      const result = await response.json();

      // Cache the result
      this.cache.set(cacheKey, {
        result,
        timestamp: Date.now(),
      });

      return result;
    } catch (error) {
      console.error("Policy evaluation failed:", error);
      return { success: false, decision: "DENY", reason: "NETWORK_ERROR" };
    }
  }

  async getPermissions(token, resource) {
    const response = await fetch(
      `${this.baseURL}/policy/permissions/${resource}?token=${token}`
    );
    return await response.json();
  }
}

export const policyClient = new PolicyClient(
  process.env.REACT_APP_USER_SERVICE_URL
);
```

### **Step 2: Create React Hooks**

```javascript
// hooks/useAuthorization.js
import { useState, useEffect, useCallback } from "react";
import { policyClient } from "../utils/policyClient";

export const useAuthorization = () => {
  const [permissions, setPermissions] = useState({});
  const [loading, setLoading] = useState(false);

  const checkPermission = useCallback(
    async (token, resource, action, context = {}) => {
      setLoading(true);
      try {
        const result = await policyClient.evaluatePolicy(
          token,
          resource,
          action,
          context
        );
        return result.success && result.decision === "PERMIT";
      } catch (error) {
        console.error("Permission check failed:", error);
        return false;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const loadPermissions = useCallback(async (token, resource) => {
    try {
      const result = await policyClient.getPermissions(token, resource);
      setPermissions((prev) => ({
        ...prev,
        [resource]: result.permissions || [],
      }));
    } catch (error) {
      console.error("Failed to load permissions:", error);
    }
  }, []);

  return {
    checkPermission,
    loadPermissions,
    permissions,
    loading,
  };
};
```

### **Step 3: Use in Components**

```javascript
// components/UserManagement.jsx
import React, { useState, useEffect } from "react";
import { useAuthorization } from "../hooks/useAuthorization";

const UserManagement = ({ token }) => {
  const { checkPermission, permissions } = useAuthorization();
  const [canCreate, setCanCreate] = useState(false);
  const [canDelete, setCanDelete] = useState(false);

  useEffect(() => {
    const loadPermissions = async () => {
      const createPermission = await checkPermission(token, "user", "write");
      const deletePermission = await checkPermission(token, "user", "delete");

      setCanCreate(createPermission);
      setCanDelete(deletePermission);
    };

    loadPermissions();
  }, [token, checkPermission]);

  return (
    <div>
      <h2>User Management</h2>

      {canCreate && <button onClick={() => createUser()}>Create User</button>}

      {canDelete && <button onClick={() => deleteUser()}>Delete User</button>}

      <UserList />
    </div>
  );
};

export default UserManagement;
```

### **Step 4: Route Protection**

```javascript
// components/ProtectedRoute.jsx
import React, { useState, useEffect } from "react";
import { Redirect } from "react-router-dom";
import { useAuthorization } from "../hooks/useAuthorization";

const ProtectedRoute = ({
  children,
  token,
  requiredResource,
  requiredAction,
  fallbackPath = "/unauthorized",
}) => {
  const { checkPermission } = useAuthorization();
  const [authorized, setAuthorized] = useState(null);

  useEffect(() => {
    const checkAuth = async () => {
      const hasPermission = await checkPermission(
        token,
        requiredResource,
        requiredAction
      );
      setAuthorized(hasPermission);
    };

    if (token && requiredResource && requiredAction) {
      checkAuth();
    }
  }, [token, requiredResource, requiredAction, checkPermission]);

  if (authorized === null) {
    return <div>Loading...</div>;
  }

  return authorized ? children : <Redirect to={fallbackPath} />;
};

export default ProtectedRoute;
```

---

## 📱 **React Native Integration**

### **Step 1: Create Policy Client (React Native)**

```javascript
// utils/policyClient.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";

class PolicyClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
  }

  async evaluatePolicy(token, resource, action, context = {}) {
    // Check network connectivity
    const netInfo = await NetInfo.fetch();
    if (!netInfo.isConnected) {
      // Return cached result if offline
      return await this.getCachedResult(token, resource, action);
    }

    const cacheKey = `${token.substring(0, 8)}:${resource}:${action}`;

    try {
      const response = await fetch(`${this.baseURL}/policy/evaluate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          token,
          resource,
          action,
          context,
        }),
      });

      const result = await response.json();

      // Cache for offline use
      await this.cacheResult(cacheKey, result);

      return result;
    } catch (error) {
      console.error("Policy evaluation failed:", error);
      // Fallback to cached result
      return await this.getCachedResult(token, resource, action);
    }
  }

  async cacheResult(key, result) {
    try {
      await AsyncStorage.setItem(
        `policy_${key}`,
        JSON.stringify({
          result,
          timestamp: Date.now(),
        })
      );
    } catch (error) {
      console.error("Failed to cache policy result:", error);
    }
  }

  async getCachedResult(token, resource, action) {
    try {
      const cacheKey = `${token.substring(0, 8)}:${resource}:${action}`;
      const cached = await AsyncStorage.getItem(`policy_${cacheKey}`);

      if (cached) {
        const { result, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < this.cacheTimeout) {
          return { ...result, cached: true };
        }
      }

      // Default deny if no cache
      return { success: false, decision: "DENY", reason: "NO_CACHE_OFFLINE" };
    } catch (error) {
      console.error("Failed to get cached result:", error);
      return { success: false, decision: "DENY", reason: "CACHE_ERROR" };
    }
  }
}

export const policyClient = new PolicyClient(
  process.env.REACT_NATIVE_USER_SERVICE_URL
);
```

### **Step 2: React Native Hooks**

```javascript
// hooks/useAuthorization.js
import { useState, useCallback } from "react";
import { policyClient } from "../utils/policyClient";

export const useAuthorization = () => {
  const [permissions, setPermissions] = useState({});
  const [loading, setLoading] = useState(false);

  const checkPermission = useCallback(
    async (token, resource, action, context = {}) => {
      setLoading(true);
      try {
        const result = await policyClient.evaluatePolicy(
          token,
          resource,
          action,
          context
        );
        return result.success && result.decision === "PERMIT";
      } catch (error) {
        console.error("Permission check failed:", error);
        return false;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return {
    checkPermission,
    permissions,
    loading,
  };
};
```

---

## 🔧 **Microservices Integration**

### **Step 1: Create Policy Middleware (Node.js)**

```javascript
// middleware/policyMiddleware.js
const axios = require("axios");

class PolicyMiddleware {
  constructor(userServiceURL, cacheTimeout = 300000) {
    this.userServiceURL = userServiceURL;
    this.cache = new Map();
    this.cacheTimeout = cacheTimeout;
  }

  async evaluatePolicy(token, resource, action, context = {}) {
    const cacheKey = `${token.substring(0, 8)}:${resource}:${action}`;

    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.result;
      }
    }

    try {
      const response = await axios.post(
        `${this.userServiceURL}/policy/evaluate`,
        {
          token,
          resource,
          action,
          context,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const result = response.data;

      // Cache the result
      this.cache.set(cacheKey, {
        result,
        timestamp: Date.now(),
      });

      return result;
    } catch (error) {
      console.error(
        "Policy evaluation failed:",
        error.response?.data || error.message
      );
      return {
        success: false,
        decision: "DENY",
        reason: "POLICY_SERVICE_ERROR",
      };
    }
  }

  // Express middleware factory
  requirePermission(resource, action) {
    return async (req, res, next) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");

        if (!token) {
          return res.status(401).json({
            success: false,
            error: "Authorization token required",
          });
        }

        const result = await this.evaluatePolicy(token, resource, action, {
          userId: req.user?.id,
          tenantId: req.user?.tenantId,
        });

        if (result.success && result.decision === "PERMIT") {
          req.policyContext = result;
          next();
        } else {
          return res.status(403).json({
            success: false,
            error: "Insufficient permissions",
            reason: result.reason,
          });
        }
      } catch (error) {
        console.error("Policy middleware error:", error);
        return res.status(500).json({
          success: false,
          error: "Authorization service error",
        });
      }
    };
  }
}

module.exports = PolicyMiddleware;
```

### **Step 2: Use in Express Routes**

```javascript
// routes/users.js
const express = require("express");
const PolicyMiddleware = require("../middleware/policyMiddleware");

const router = express.Router();
const policy = new PolicyMiddleware(process.env.USER_SERVICE_URL);

// Protect routes with centralized RBAC
router.get(
  "/users",
  policy.requirePermission("user", "read"),
  UserController.getAllUsers
);

router.post(
  "/users",
  policy.requirePermission("user", "write"),
  UserController.createUser
);

router.delete(
  "/users/:id",
  policy.requirePermission("user", "delete"),
  UserController.deleteUser
);

module.exports = router;
```

### **Step 3: Custom Permission Checks**

```javascript
// controllers/userController.js
const PolicyMiddleware = require("../middleware/policyMiddleware");

const policy = new PolicyMiddleware(process.env.USER_SERVICE_URL);

class UserController {
  async getUserProfile(req, res) {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      // Check specific permission
      const canViewProfile = await policy.evaluatePolicy(
        token,
        "user",
        "read",
        { targetUserId: req.params.userId }
      );

      if (!canViewProfile.success) {
        return res.status(403).json({
          success: false,
          error: "Cannot view this user profile",
        });
      }

      // Fetch and return user profile
      const profile = await User.findById(req.params.userId);
      res.json({ success: true, data: profile });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Internal server error",
      });
    }
  }
}
```

---

## 🔄 **Batch Operations**

### **Preload Permissions (React/React Native)**

```javascript
// utils/permissionPreloader.js
import { policyClient } from "./policyClient";

export const preloadPermissions = async (token, resources) => {
  const requests = resources.map((resource) => ({
    token,
    resource,
    action: "read",
  }));

  try {
    const response = await fetch(
      `${process.env.REACT_APP_USER_SERVICE_URL}/policy/evaluate-batch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ requests }),
      }
    );

    const results = await response.json();
    return results.results;
  } catch (error) {
    console.error("Failed to preload permissions:", error);
    return [];
  }
};

// Usage in React component
useEffect(() => {
  const loadPermissions = async () => {
    const permissions = await preloadPermissions(token, [
      "user",
      "role",
      "crm",
    ]);
    // Process permissions...
  };

  loadPermissions();
}, [token]);
```

---

## 🚀 **Performance Optimizations**

### **1. Caching Strategy**

- **Client-side caching**: 5-minute cache for policy decisions
- **Redis caching**: Server-side caching in your user-service
- **Offline support**: React Native apps cache permissions locally

### **2. Batch Requests**

- Use `/policy/evaluate-batch` for multiple permission checks
- Preload common permissions on app startup
- Cache results to reduce API calls

### **3. Network Optimization**

- HTTP/2 support for concurrent requests
- Compression for policy responses
- Connection pooling for microservices

---

## 🔐 **Security Considerations**

### **1. Token Security**

- Always use HTTPS for policy evaluation requests
- Implement token refresh mechanisms
- Validate token expiration on client side

### **2. Caching Security**

- Don't cache sensitive authorization decisions
- Implement cache invalidation on role changes
- Use secure storage for mobile apps

### **3. Error Handling**

- Graceful degradation when policy service is unavailable
- Default to "deny" when in doubt
- Log authorization failures for monitoring

---

## 📊 **Monitoring & Analytics**

### **1. Policy Evaluation Metrics**

```javascript
// Track authorization metrics
const trackPolicyEvaluation = (resource, action, decision, responseTime) => {
  // Send to your analytics service
  analytics.track("policy_evaluation", {
    resource,
    action,
    decision,
    responseTime,
    timestamp: new Date().toISOString(),
  });
};
```

### **2. Cache Performance**

- Monitor cache hit rates
- Track policy service response times
- Alert on high failure rates

---

## ✅ **Implementation Checklist**

### **For React.js Applications:**

- [ ] Install policy client utility
- [ ] Create authorization hooks
- [ ] Implement route protection
- [ ] Add permission-based UI rendering
- [ ] Set up error boundaries for auth failures

### **For React Native Applications:**

- [ ] Install AsyncStorage for offline caching
- [ ] Implement offline permission checking
- [ ] Add network connectivity checks
- [ ] Set up secure token storage

### **For Microservices:**

- [ ] Install policy middleware
- [ ] Protect API routes with policy checks
- [ ] Implement custom permission logic
- [ ] Set up error handling and logging

### **For All Applications:**

- [ ] Configure user-service URL
- [ ] Set up caching strategy
- [ ] Implement error handling
- [ ] Add monitoring and analytics
- [ ] Test authorization flows

---

Your centralized RBAC system is now ready to serve all your applications and services with consistent, secure, and performant authorization! 🎉
