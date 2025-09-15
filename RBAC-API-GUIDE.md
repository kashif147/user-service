# RBAC API Integration Guide

## 🎯 **Microservices Integration with Centralized RBAC**

This guide shows how to integrate your microservices and APIs with the centralized RBAC user-service for authentication and authorization.

---

## 📦 **Installation & Setup**

### **1. Install Dependencies**

```bash
npm install axios express-oauth-server
# or
yarn add axios express-oauth-server
```

### **2. Environment Configuration**

Create `.env` file in your microservice:

```env
USER_SERVICE_URL=http://localhost:3000
JWT_SECRET=your-jwt-secret
TENANT_ID=your-tenant-id
```

---

## 🔧 **Core Integration Components**

### **1. Policy Middleware**

Create `middleware/policyMiddleware.js`:

```javascript
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
          timeout: 10000, // 10 second timeout
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
            code: "MISSING_TOKEN",
          });
        }

        const result = await this.evaluatePolicy(token, resource, action, {
          userId: req.user?.id,
          tenantId: req.user?.tenantId,
          ...req.query, // Include query parameters as context
        });

        if (result.success && result.decision === "PERMIT") {
          req.policyContext = result;
          req.user = result.user;
          next();
        } else {
          return res.status(403).json({
            success: false,
            error: "Insufficient permissions",
            reason: result.reason,
            code: "INSUFFICIENT_PERMISSIONS",
          });
        }
      } catch (error) {
        console.error("Policy middleware error:", error);
        return res.status(500).json({
          success: false,
          error: "Authorization service error",
          code: "POLICY_SERVICE_ERROR",
        });
      }
    };
  }

  // Batch evaluation middleware
  requireMultiplePermissions(permissions) {
    return async (req, res, next) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");

        if (!token) {
          return res.status(401).json({
            success: false,
            error: "Authorization token required",
            code: "MISSING_TOKEN",
          });
        }

        const requests = permissions.map(
          ({ resource, action, context = {} }) => ({
            token,
            resource,
            action,
            context: {
              userId: req.user?.id,
              tenantId: req.user?.tenantId,
              ...context,
            },
          })
        );

        const response = await axios.post(
          `${this.userServiceURL}/policy/evaluate-batch`,
          { requests },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            timeout: 15000,
          }
        );

        const result = response.data;

        if (result.success) {
          req.policyContext = result;
          req.permissions = {};

          permissions.forEach((permission, index) => {
            const key = `${permission.resource}_${permission.action}`;
            req.permissions[key] = result.results[index]?.success || false;
          });

          next();
        } else {
          return res.status(403).json({
            success: false,
            error: "Batch permission evaluation failed",
            code: "BATCH_EVALUATION_FAILED",
          });
        }
      } catch (error) {
        console.error("Batch policy middleware error:", error);
        return res.status(500).json({
          success: false,
          error: "Authorization service error",
          code: "POLICY_SERVICE_ERROR",
        });
      }
    };
  }

  // Custom permission check
  async checkPermission(token, resource, action, context = {}) {
    const result = await this.evaluatePolicy(token, resource, action, context);
    return result.success && result.decision === "PERMIT";
  }

  // Get user permissions
  async getUserPermissions(token, resource) {
    try {
      const response = await axios.get(
        `${this.userServiceURL}/policy/permissions/${resource}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );
      return response.data;
    } catch (error) {
      console.error("Failed to get user permissions:", error);
      return { success: false, permissions: [] };
    }
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
  }

  // Get cache stats
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

module.exports = PolicyMiddleware;
```

### **2. Authentication Middleware**

Create `middleware/authMiddleware.js`:

```javascript
const jwt = require("jsonwebtoken");

class AuthMiddleware {
  constructor(jwtSecret) {
    this.jwtSecret = jwtSecret;
  }

  // Verify JWT token
  verifyToken() {
    return (req, res, next) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");

        if (!token) {
          return res.status(401).json({
            success: false,
            error: "Authorization token required",
            code: "MISSING_TOKEN",
          });
        }

        const decoded = jwt.verify(token, this.jwtSecret);

        // Check expiration
        const now = Math.floor(Date.now() / 1000);
        if (decoded.exp && decoded.exp < now) {
          return res.status(401).json({
            success: false,
            error: "Token expired",
            code: "TOKEN_EXPIRED",
          });
        }

        req.user = {
          id: decoded.sub || decoded.id,
          email: decoded.email,
          tenantId: decoded.tid,
          userType: decoded.userType,
          roles: decoded.roles || [],
          permissions: decoded.permissions || [],
        };

        next();
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({
          success: false,
          error: "Invalid token",
          code: "INVALID_TOKEN",
        });
      }
    };
  }

  // Optional token verification (doesn't fail if no token)
  optionalToken() {
    return (req, res, next) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");

        if (token) {
          const decoded = jwt.verify(token, this.jwtSecret);

          // Check expiration
          const now = Math.floor(Date.now() / 1000);
          if (decoded.exp && decoded.exp >= now) {
            req.user = {
              id: decoded.sub || decoded.id,
              email: decoded.email,
              tenantId: decoded.tid,
              userType: decoded.userType,
              roles: decoded.roles || [],
              permissions: decoded.permissions || [],
            };
          }
        }

        next();
      } catch (error) {
        // Continue without user if token is invalid
        console.warn("Optional token verification failed:", error.message);
        next();
      }
    };
  }

  // Require specific user type
  requireUserType(userTypes) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTHENTICATION_REQUIRED",
        });
      }

      if (!userTypes.includes(req.user.userType)) {
        return res.status(403).json({
          success: false,
          error: "Invalid user type",
          code: "INVALID_USER_TYPE",
        });
      }

      next();
    };
  }

  // Require specific role
  requireRole(roles) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTHENTICATION_REQUIRED",
        });
      }

      const userRoles = req.user.roles.map((role) =>
        typeof role === "string" ? role : role.code
      );

      const hasRequiredRole = roles.some((role) => userRoles.includes(role));

      if (!hasRequiredRole) {
        return res.status(403).json({
          success: false,
          error: "Insufficient role",
          code: "INSUFFICIENT_ROLE",
        });
      }

      next();
    };
  }

  // Require tenant access
  requireTenant() {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTHENTICATION_REQUIRED",
        });
      }

      if (!req.user.tenantId) {
        return res.status(403).json({
          success: false,
          error: "Tenant context required",
          code: "MISSING_TENANT_CONTEXT",
        });
      }

      // Add tenant filter to request
      req.tenantFilter = { tenantId: req.user.tenantId };
      next();
    };
  }
}

module.exports = AuthMiddleware;
```

### **3. Error Handling Middleware**

Create `middleware/errorMiddleware.js`:

```javascript
class ErrorMiddleware {
  // Global error handler
  static errorHandler(err, req, res, next) {
    console.error("Error:", err);

    // Policy service errors
    if (err.code === "POLICY_SERVICE_ERROR") {
      return res.status(503).json({
        success: false,
        error: "Authorization service unavailable",
        code: "POLICY_SERVICE_UNAVAILABLE",
      });
    }

    // JWT errors
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        error: "Invalid token",
        code: "INVALID_TOKEN",
      });
    }

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        error: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }

    // Validation errors
    if (err.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: err.message,
        code: "VALIDATION_ERROR",
      });
    }

    // Default error
    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }

  // 404 handler
  static notFound(req, res, next) {
    res.status(404).json({
      success: false,
      error: "Route not found",
      code: "ROUTE_NOT_FOUND",
    });
  }

  // Async error wrapper
  static asyncHandler(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }
}

module.exports = ErrorMiddleware;
```

---

## 🛡️ **Route Protection**

### **1. Basic Route Protection**

```javascript
// routes/users.js
const express = require("express");
const PolicyMiddleware = require("../middleware/policyMiddleware");
const AuthMiddleware = require("../middleware/authMiddleware");

const router = express.Router();
const policy = new PolicyMiddleware(process.env.USER_SERVICE_URL);
const auth = new AuthMiddleware(process.env.JWT_SECRET);

// Protect routes with centralized RBAC
router.get(
  "/users",
  auth.verifyToken(),
  auth.requireTenant(),
  policy.requirePermission("user", "read"),
  UserController.getAllUsers
);

router.post(
  "/users",
  auth.verifyToken(),
  auth.requireUserType(["CRM"]),
  policy.requirePermission("user", "write"),
  UserController.createUser
);

router.put(
  "/users/:id",
  auth.verifyToken(),
  auth.requireTenant(),
  policy.requirePermission("user", "write"),
  UserController.updateUser
);

router.delete(
  "/users/:id",
  auth.verifyToken(),
  auth.requireRole(["SU", "GS", "DGS"]),
  policy.requirePermission("user", "delete"),
  UserController.deleteUser
);

module.exports = router;
```

### **2. Advanced Route Protection**

```javascript
// routes/admin.js
const express = require("express");
const PolicyMiddleware = require("../middleware/policyMiddleware");
const AuthMiddleware = require("../middleware/authMiddleware");

const router = express.Router();
const policy = new PolicyMiddleware(process.env.USER_SERVICE_URL);
const auth = new AuthMiddleware(process.env.JWT_SECRET);

// Multiple permission requirements
router.get(
  "/dashboard",
  auth.verifyToken(),
  auth.requireUserType(["CRM"]),
  policy.requireMultiplePermissions([
    { resource: "crm", action: "read" },
    { resource: "user", action: "read" },
    { resource: "role", action: "read" },
  ]),
  AdminController.getDashboard
);

// Conditional permissions based on route parameters
router.get(
  "/users/:id/profile",
  auth.verifyToken(),
  auth.requireTenant(),
  async (req, res, next) => {
    try {
      // Check if user can view their own profile or has admin access
      const isOwnProfile = req.user.id === req.params.id;
      const hasAdminAccess = await policy.checkPermission(
        req.headers.authorization.replace("Bearer ", ""),
        "user",
        "read",
        { targetUserId: req.params.id }
      );

      if (isOwnProfile || hasAdminAccess) {
        next();
      } else {
        return res.status(403).json({
          success: false,
          error: "Cannot view this profile",
          code: "INSUFFICIENT_PERMISSIONS",
        });
      }
    } catch (error) {
      next(error);
    }
  },
  UserController.getProfile
);

module.exports = router;
```

---

## 🎨 **Controller Examples**

### **1. User Controller**

Create `controllers/userController.js`:

```javascript
const PolicyMiddleware = require("../middleware/policyMiddleware");

class UserController {
  constructor() {
    this.policy = new PolicyMiddleware(process.env.USER_SERVICE_URL);
  }

  // Get all users (with tenant filtering)
  async getAllUsers(req, res, next) {
    try {
      const { tenantFilter } = req;
      const users = await User.find(tenantFilter);

      res.json({
        success: true,
        data: users,
        count: users.length,
      });
    } catch (error) {
      next(error);
    }
  }

  // Create user
  async createUser(req, res, next) {
    try {
      const { tenantFilter } = req;
      const userData = {
        ...req.body,
        tenantId: tenantFilter.tenantId,
        createdBy: req.user.id,
      };

      const user = await User.create(userData);

      res.status(201).json({
        success: true,
        data: user,
        message: "User created successfully",
      });
    } catch (error) {
      next(error);
    }
  }

  // Update user
  async updateUser(req, res, next) {
    try {
      const { tenantFilter } = req;
      const { id } = req.params;

      // Check if user exists in tenant
      const user = await User.findOne({ _id: id, ...tenantFilter });
      if (!user) {
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });
      }

      const updatedUser = await User.findByIdAndUpdate(
        id,
        { ...req.body, updatedBy: req.user.id },
        { new: true }
      );

      res.json({
        success: true,
        data: updatedUser,
        message: "User updated successfully",
      });
    } catch (error) {
      next(error);
    }
  }

  // Delete user
  async deleteUser(req, res, next) {
    try {
      const { tenantFilter } = req;
      const { id } = req.params;

      const user = await User.findOne({ _id: id, ...tenantFilter });
      if (!user) {
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });
      }

      await User.findByIdAndDelete(id);

      res.json({
        success: true,
        message: "User deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  }

  // Get user profile
  async getProfile(req, res, next) {
    try {
      const { id } = req.params;
      const user = await User.findById(id).populate("roles");

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  // Assign role to user
  async assignRole(req, res, next) {
    try {
      const { userId, roleId } = req.body;
      const { tenantFilter } = req;

      // Check if user and role exist in tenant
      const user = await User.findOne({ _id: userId, ...tenantFilter });
      const role = await Role.findOne({ _id: roleId, ...tenantFilter });

      if (!user || !role) {
        return res.status(404).json({
          success: false,
          error: "User or role not found",
          code: "RESOURCE_NOT_FOUND",
        });
      }

      // Check if user has permission to assign this role
      const canAssignRole = await this.policy.checkPermission(
        req.headers.authorization.replace("Bearer ", ""),
        "role",
        "assign",
        { targetUserId: userId, roleId }
      );

      if (!canAssignRole) {
        return res.status(403).json({
          success: false,
          error: "Cannot assign this role",
          code: "INSUFFICIENT_PERMISSIONS",
        });
      }

      user.roles.push(roleId);
      await user.save();

      res.json({
        success: true,
        message: "Role assigned successfully",
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new UserController();
```

### **2. Role Controller**

Create `controllers/roleController.js`:

```javascript
const PolicyMiddleware = require("../middleware/policyMiddleware");

class RoleController {
  constructor() {
    this.policy = new PolicyMiddleware(process.env.USER_SERVICE_URL);
  }

  // Get all roles
  async getAllRoles(req, res, next) {
    try {
      const { tenantFilter } = req;
      const roles = await Role.find(tenantFilter);

      res.json({
        success: true,
        data: roles,
        count: roles.length,
      });
    } catch (error) {
      next(error);
    }
  }

  // Create role
  async createRole(req, res, next) {
    try {
      const { tenantFilter } = req;
      const roleData = {
        ...req.body,
        tenantId: tenantFilter.tenantId,
        createdBy: req.user.id,
      };

      const role = await Role.create(roleData);

      res.status(201).json({
        success: true,
        data: role,
        message: "Role created successfully",
      });
    } catch (error) {
      next(error);
    }
  }

  // Update role permissions
  async updateRolePermissions(req, res, next) {
    try {
      const { id } = req.params;
      const { permissions } = req.body;
      const { tenantFilter } = req;

      const role = await Role.findOne({ _id: id, ...tenantFilter });
      if (!role) {
        return res.status(404).json({
          success: false,
          error: "Role not found",
          code: "ROLE_NOT_FOUND",
        });
      }

      role.permissions = permissions;
      role.updatedBy = req.user.id;
      await role.save();

      res.json({
        success: true,
        data: role,
        message: "Role permissions updated successfully",
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new RoleController();
```

---

## 🔄 **Service Integration**

### **1. Policy Service Client**

Create `services/policyService.js`:

```javascript
const axios = require("axios");

class PolicyService {
  constructor(userServiceURL) {
    this.userServiceURL = userServiceURL;
  }

  async evaluatePolicy(token, resource, action, context = {}) {
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
          timeout: 10000,
        }
      );

      return response.data;
    } catch (error) {
      console.error("Policy evaluation failed:", error);
      return {
        success: false,
        decision: "DENY",
        reason: "POLICY_SERVICE_ERROR",
      };
    }
  }

  async getUserPermissions(token, resource) {
    try {
      const response = await axios.get(
        `${this.userServiceURL}/policy/permissions/${resource}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );

      return response.data;
    } catch (error) {
      console.error("Failed to get user permissions:", error);
      return { success: false, permissions: [] };
    }
  }

  async evaluateBatch(requests) {
    try {
      const response = await axios.post(
        `${this.userServiceURL}/policy/evaluate-batch`,
        { requests },
        {
          headers: {
            Authorization: `Bearer ${requests[0]?.token}`,
          },
          timeout: 15000,
        }
      );

      return response.data;
    } catch (error) {
      console.error("Batch evaluation failed:", error);
      return { success: false, results: [] };
    }
  }

  async validateToken(token) {
    try {
      const response = await axios.get(
        `${this.userServiceURL}/policy/check/portal/read`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 5000,
        }
      );

      return response.data.success;
    } catch (error) {
      console.error("Token validation failed:", error);
      return false;
    }
  }
}

module.exports = new PolicyService(process.env.USER_SERVICE_URL);
```

### **2. User Service Client**

Create `services/userService.js`:

```javascript
const axios = require("axios");

class UserService {
  constructor(userServiceURL) {
    this.userServiceURL = userServiceURL;
  }

  async getUserById(userId, token) {
    try {
      const response = await axios.get(
        `${this.userServiceURL}/api/users/${userId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );

      return response.data;
    } catch (error) {
      console.error("Failed to get user:", error);
      return { success: false, error: error.message };
    }
  }

  async updateUser(userId, userData, token) {
    try {
      const response = await axios.put(
        `${this.userServiceURL}/api/users/${userId}`,
        userData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );

      return response.data;
    } catch (error) {
      console.error("Failed to update user:", error);
      return { success: false, error: error.message };
    }
  }

  async assignRole(userId, roleId, token) {
    try {
      const response = await axios.post(
        `${this.userServiceURL}/api/tenant-scoped/assign-role`,
        {
          userId,
          roleId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );

      return response.data;
    } catch (error) {
      console.error("Failed to assign role:", error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new UserService(process.env.USER_SERVICE_URL);
```

---

## 📊 **Advanced Features**

### **1. Caching Strategy**

Create `utils/cache.js`:

```javascript
const NodeCache = require("node-cache");

class CacheManager {
  constructor(ttl = 300) {
    this.cache = new NodeCache({ stdTTL: ttl });
  }

  async get(key) {
    return this.cache.get(key);
  }

  async set(key, value, ttl = null) {
    if (ttl) {
      this.cache.set(key, value, ttl);
    } else {
      this.cache.set(key, value);
    }
  }

  async del(key) {
    this.cache.del(key);
  }

  async clear() {
    this.cache.flushAll();
  }

  getStats() {
    return this.cache.getStats();
  }
}

module.exports = CacheManager;
```

### **2. Rate Limiting**

Create `middleware/rateLimiting.js`:

```javascript
const rateLimit = require("express-rate-limit");

class RateLimiting {
  static createLimiter(options = {}) {
    return rateLimit({
      windowMs: options.windowMs || 15 * 60 * 1000, // 15 minutes
      max: options.max || 100, // limit each IP to 100 requests per windowMs
      message: {
        success: false,
        error: "Too many requests",
        code: "RATE_LIMIT_EXCEEDED",
      },
      standardHeaders: true,
      legacyHeaders: false,
      ...options,
    });
  }

  static authLimiter() {
    return this.createLimiter({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // limit each IP to 5 requests per windowMs
      message: {
        success: false,
        error: "Too many authentication attempts",
        code: "AUTH_RATE_LIMIT_EXCEEDED",
      },
    });
  }

  static apiLimiter() {
    return this.createLimiter({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 1000, // limit each IP to 1000 requests per windowMs
    });
  }
}

module.exports = RateLimiting;
```

### **3. Audit Logging**

Create `middleware/auditMiddleware.js`:

```javascript
class AuditMiddleware {
  static logAction(action, resource, userId, details = {}) {
    const auditLog = {
      timestamp: new Date().toISOString(),
      action,
      resource,
      userId,
      details,
      ip: details.ip,
      userAgent: details.userAgent,
    };

    // Log to console (replace with your logging service)
    console.log("AUDIT:", JSON.stringify(auditLog));

    // You can also send to external logging service
    // await this.sendToLoggingService(auditLog);
  }

  static auditMiddleware(action, resource) {
    return (req, res, next) => {
      const originalSend = res.send;

      res.send = function (data) {
        // Log after response is sent
        AuditMiddleware.logAction(action, resource, req.user?.id, {
          ip: req.ip,
          userAgent: req.get("User-Agent"),
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          responseSize: data ? data.length : 0,
        });

        originalSend.call(this, data);
      };

      next();
    };
  }
}

module.exports = AuditMiddleware;
```

---

## 🚀 **Application Setup**

### **1. Express App Configuration**

Create `app.js`:

```javascript
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const PolicyMiddleware = require("./middleware/policyMiddleware");
const AuthMiddleware = require("./middleware/authMiddleware");
const ErrorMiddleware = require("./middleware/errorMiddleware");
const RateLimiting = require("./middleware/rateLimiting");
const AuditMiddleware = require("./middleware/auditMiddleware");

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());

// Rate limiting
app.use(RateLimiting.apiLimiter());

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl} - ${req.ip}`);
  next();
});

// Routes
app.use("/api/users", require("./routes/users"));
app.use("/api/roles", require("./routes/roles"));
app.use("/api/admin", require("./routes/admin"));

// Health check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// Error handling
app.use(ErrorMiddleware.notFound);
app.use(ErrorMiddleware.errorHandler);

module.exports = app;
```

### **2. Server Startup**

Create `server.js`:

```javascript
const app = require("./app");
const mongoose = require("mongoose");

const PORT = process.env.PORT || 3001;

// Database connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

mongoose.connection.on("connected", () => {
  console.log("Connected to MongoDB");
});

mongoose.connection.on("error", (err) => {
  console.error("MongoDB connection error:", err);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
```

---

## 🚀 **Best Practices**

### **1. Security**

- Always validate tokens on every request
- Implement proper error handling
- Use HTTPS in production
- Implement rate limiting
- Log all authorization attempts

### **2. Performance**

- Cache policy decisions
- Use connection pooling
- Implement request timeouts
- Monitor service health

### **3. Error Handling**

- Provide meaningful error messages
- Log errors for debugging
- Implement circuit breakers
- Handle service unavailability gracefully

### **4. Monitoring**

- Monitor policy evaluation performance
- Track authorization failures
- Monitor cache hit rates
- Alert on service failures

---

## ✅ **Implementation Checklist**

- [ ] Install required dependencies
- [ ] Set up environment variables
- [ ] Create policy middleware
- [ ] Create authentication middleware
- [ ] Implement error handling
- [ ] Set up route protection
- [ ] Create controllers with RBAC
- [ ] Implement caching strategy
- [ ] Add rate limiting
- [ ] Set up audit logging
- [ ] Configure Express app
- [ ] Test authentication flow
- [ ] Test permission checks
- [ ] Test error handling
- [ ] Test performance
- [ ] Set up monitoring

---

Your microservice is now fully integrated with the centralized RBAC system! 🎉
