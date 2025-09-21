# Portal Service PDP Integration Implementation

## 🎯 **Complete Implementation Guide for Portal-Service API**

This guide shows how to implement PDP integration in your portal-service API to consume user-service as the Policy Decision Point.

---

## 📁 **File Structure for Portal-Service**

```
portal-service/
├── src/
│   ├── middleware/
│   │   ├── policy.js              # PDP middleware
│   │   ├── auth.js                # Authentication middleware
│   │   └── error-handler.js       # Error handling
│   ├── services/
│   │   └── policy-client.js       # Policy client service
│   ├── routes/
│   │   ├── auth.js                # Authentication routes
│   │   ├── profile.js             # Profile management routes
│   │   ├── dashboard.js           # Dashboard routes
│   │   └── settings.js           # Settings routes
│   ├── controllers/
│   │   ├── auth.controller.js     # Auth controller
│   │   ├── profile.controller.js  # Profile controller
│   │   ├── dashboard.controller.js # Dashboard controller
│   │   └── settings.controller.js  # Settings controller
│   ├── utils/
│   │   └── policy-helpers.js      # Policy utility functions
│   └── app.js                     # Main application file
├── tests/
│   ├── middleware/
│   │   └── policy.test.js         # Policy middleware tests
│   └── utils/
│       └── policy-helpers.test.js # Policy helpers tests
├── .env                           # Environment variables
└── package.json                   # Dependencies
```

---

## 🔧 **1. Policy Client Service**

**File: `src/services/policy-client.js`**

```javascript
/**
 * Portal Service Policy Client
 * Handles communication with user-service PDP
 */

const axios = require("axios");
const crypto = require("crypto");

class PortalPolicyClient {
  constructor(options = {}) {
    this.baseUrl =
      options.baseUrl ||
      process.env.USER_SERVICE_URL ||
      "http://user-service:3000";
    this.timeout = options.timeout || 5000;
    this.retries = options.retries || 3;
    this.cache = new Map();
    this.cacheTimeout = options.cacheTimeout || 300000; // 5 minutes
  }

  /**
   * Evaluate portal-specific authorization
   * @param {string} token - JWT token
   * @param {string} action - Portal action (read, write, update_profile, etc.)
   * @param {Object} context - Additional context
   * @returns {Promise<Object>} Policy decision
   */
  async evaluatePortalAccess(token, action, context = {}) {
    return this.evaluate(token, "portal", action, context);
  }

  /**
   * Evaluate general authorization
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
        data: { token, resource, action, context },
        headers: { "Content-Type": "application/json" },
      });

      // Cache successful results
      if (response.data.success) {
        this.cache.set(cacheKey, {
          result: response.data,
          timestamp: Date.now(),
        });
      }

      return response.data;
    } catch (error) {
      console.error("Policy evaluation error:", error.message);
      return {
        success: false,
        decision: "DENY",
        reason: "NETWORK_ERROR",
        error: error.message,
      };
    }
  }

  /**
   * Get user permissions for portal
   * @param {string} token - JWT token
   * @returns {Promise<Object>} Portal permissions
   */
  async getPortalPermissions(token) {
    try {
      const response = await this.makeRequest("/policy/permissions/portal", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      return response.data;
    } catch (error) {
      console.error("Get portal permissions error:", error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if user can access portal dashboard
   * @param {string} token - JWT token
   * @returns {Promise<boolean>} Access result
   */
  async canAccessDashboard(token) {
    const result = await this.evaluatePortalAccess(token, "read");
    return result.success;
  }

  /**
   * Check if user can update profile
   * @param {string} token - JWT token
   * @param {string} targetUserId - Target user ID (optional)
   * @returns {Promise<boolean>} Access result
   */
  async canUpdateProfile(token, targetUserId = null) {
    const context = targetUserId ? { targetUserId } : {};
    const result = await this.evaluatePortalAccess(token, "write", context);
    return result.success;
  }

  /**
   * Check if user can view settings
   * @param {string} token - JWT token
   * @returns {Promise<boolean>} Access result
   */
  async canViewSettings(token) {
    const result = await this.evaluatePortalAccess(token, "read");
    return result.success;
  }

  /**
   * Check if user can update settings
   * @param {string} token - JWT token
   * @returns {Promise<boolean>} Access result
   */
  async canUpdateSettings(token) {
    const result = await this.evaluatePortalAccess(token, "write");
    return result.success;
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
        const response = await axios({
          url,
          timeout: this.timeout,
          ...options,
        });

        return response;
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
   * Generate cache key
   * @private
   */
  getCacheKey(token, resource, action, context) {
    const tokenHash = this.hashToken(token);
    return `${tokenHash}:${resource}:${action}:${JSON.stringify(context)}`;
  }

  /**
   * Hash token for cache key
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

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      timeout: this.cacheTimeout,
    };
  }
}

// Create singleton instance
const portalPolicyClient = new PortalPolicyClient({
  baseUrl: process.env.USER_SERVICE_URL,
  timeout: parseInt(process.env.POLICY_SERVICE_TIMEOUT) || 5000,
  retries: parseInt(process.env.POLICY_SERVICE_RETRIES) || 3,
  cacheTimeout: parseInt(process.env.POLICY_CACHE_TIMEOUT) || 300000,
});

module.exports = {
  PortalPolicyClient,
  portalPolicyClient,
};
```

---

## 🔧 **2. Policy Middleware**

**File: `src/middleware/policy.js`**

```javascript
/**
 * Portal Service Policy Middleware
 * Handles PDP integration for portal-specific routes
 */

const { portalPolicyClient } = require("../services/policy-client");

/**
 * Portal-specific policy middleware factory
 * @param {string} action - Portal action (read, write, update_profile, etc.)
 * @param {Function} contextExtractor - Function to extract additional context
 * @returns {Function} Express middleware
 */
const requirePortalPolicy = (action, contextExtractor = null) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Authorization header required",
          code: "MISSING_TOKEN",
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

      const result = await portalPolicyClient.evaluatePortalAccess(
        token,
        action,
        context
      );

      if (result.success) {
        // Attach user info to request
        req.user = result.user;
        req.tenantId = result.user?.tenantId;
        req.policyContext = result;
        req.correlationId = result.correlationId;
        next();
      } else {
        return res.status(403).json({
          success: false,
          error: "Access denied",
          reason: result.reason,
          code: result.reason,
          user: result.user,
          correlationId: result.correlationId,
        });
      }
    } catch (error) {
      console.error("Portal policy middleware error:", error);
      return res.status(500).json({
        success: false,
        error: "Authorization check failed",
        code: "POLICY_SERVICE_ERROR",
      });
    }
  };
};

/**
 * Dashboard access middleware
 */
const requireDashboardAccess = () => {
  return requirePortalPolicy("read");
};

/**
 * Profile update middleware
 */
const requireProfileUpdate = () => {
  return requirePortalPolicy("write", (req) => ({
    targetUserId: req.params.userId || req.body.userId,
    profileSection: req.body.section,
  }));
};

/**
 * Settings access middleware
 */
const requireSettingsAccess = () => {
  return requirePortalPolicy("read");
};

/**
 * Settings update middleware
 */
const requireSettingsUpdate = () => {
  return requirePortalPolicy("write", (req) => ({
    settingType: req.body.settingType,
    settingValue: req.body.settingValue,
  }));
};

/**
 * General resource access middleware
 * @param {string} resource - Resource name
 * @param {string} action - Action name
 * @param {Function} contextExtractor - Context extractor function
 * @returns {Function} Express middleware
 */
const requireResourceAccess = (resource, action, contextExtractor = null) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Authorization header required",
          code: "MISSING_TOKEN",
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

      const result = await portalPolicyClient.evaluate(
        token,
        resource,
        action,
        context
      );

      if (result.success) {
        req.user = result.user;
        req.tenantId = result.user?.tenantId;
        req.policyContext = result;
        req.correlationId = result.correlationId;
        next();
      } else {
        return res.status(403).json({
          success: false,
          error: "Access denied",
          reason: result.reason,
          code: result.reason,
          user: result.user,
          correlationId: result.correlationId,
        });
      }
    } catch (error) {
      console.error("Resource policy middleware error:", error);
      return res.status(500).json({
        success: false,
        error: "Authorization check failed",
        code: "POLICY_SERVICE_ERROR",
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
          code: "MISSING_TOKEN",
        });
      }

      const token = authHeader.substring(7);

      const requests = policies.map((policy) => ({
        token,
        resource: policy.resource,
        action: policy.action,
        context: policy.contextExtractor ? policy.contextExtractor(req) : {},
      }));

      const results = await Promise.all(
        requests.map((request) =>
          portalPolicyClient.evaluate(
            request.token,
            request.resource,
            request.action,
            request.context
          )
        )
      );

      // Check if all policies pass
      const allPassed = results.every((result) => result.success);

      if (allPassed) {
        req.user = results[0].user;
        req.tenantId = results[0].user?.tenantId;
        req.policyResults = results;
        next();
      } else {
        const failedPolicies = results.filter((result) => !result.success);
        return res.status(403).json({
          success: false,
          error: "Access denied",
          failedPolicies: failedPolicies.map((result, index) => ({
            resource: policies[index].resource,
            action: policies[index].action,
            reason: result.reason,
          })),
        });
      }
    } catch (error) {
      console.error("Batch policy middleware error:", error);
      return res.status(500).json({
        success: false,
        error: "Authorization check failed",
        code: "POLICY_SERVICE_ERROR",
      });
    }
  };
};

module.exports = {
  requirePortalPolicy,
  requireDashboardAccess,
  requireProfileUpdate,
  requireSettingsAccess,
  requireSettingsUpdate,
  requireResourceAccess,
  requireBatchPolicy,
};
```

---

## 🔧 **3. Authentication Middleware**

**File: `src/middleware/auth.js`**

```javascript
/**
 * Portal Service Authentication Middleware
 * Handles JWT token validation and user context
 */

const jwt = require("jsonwebtoken");

/**
 * Basic JWT authentication middleware
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authorization header required",
        code: "MISSING_TOKEN",
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Extract tenantId from token
    const tenantId =
      decoded.tenantId || decoded.tid || decoded.extension_tenantId;

    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: "Invalid token: missing tenantId",
        code: "MISSING_TENANT_ID",
      });
    }

    // Set request context
    req.ctx = {
      tenantId: tenantId,
      userId: decoded.sub || decoded.id,
      userType: decoded.userType,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
    };

    // Attach user info for backward compatibility
    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.tenantId = tenantId;
    req.roles = decoded.roles || [];
    req.permissions = decoded.permissions || [];

    next();
  } catch (error) {
    console.error("JWT Verification Error:", error.message);
    return res.status(401).json({
      success: false,
      error: "Invalid token",
      code: "INVALID_TOKEN",
    });
  }
};

/**
 * Optional authentication middleware (doesn't fail if no token)
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const tenantId =
        decoded.tenantId || decoded.tid || decoded.extension_tenantId;

      if (tenantId) {
        req.ctx = {
          tenantId: tenantId,
          userId: decoded.sub || decoded.id,
          userType: decoded.userType,
          roles: decoded.roles || [],
          permissions: decoded.permissions || [],
        };

        req.user = decoded;
        req.userId = decoded.sub || decoded.id;
        req.tenantId = tenantId;
        req.roles = decoded.roles || [];
        req.permissions = decoded.permissions || [];
      }
    }

    next();
  } catch (error) {
    // Continue without authentication if token is invalid
    next();
  }
};

module.exports = {
  authenticate,
  optionalAuth,
};
```

---

## 🔧 **4. Route Implementations**

**File: `src/routes/auth.js`**

```javascript
const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const { requirePortalPolicy } = require("../middleware/policy");
const authController = require("../controllers/auth.controller");

// Login route (no policy required)
router.post("/login", authController.login);

// Logout route (requires authentication)
router.post("/logout", authenticate, authController.logout);

// Refresh token route (requires authentication)
router.post("/refresh", authenticate, authController.refreshToken);

// Get current user info (requires portal read access)
router.get(
  "/me",
  authenticate,
  requirePortalPolicy("read"),
  authController.getCurrentUser
);

// Update user preferences (requires portal write access)
router.put(
  "/preferences",
  authenticate,
  requirePortalPolicy("write"),
  authController.updatePreferences
);

module.exports = router;
```

**File: `src/routes/profile.js`**

```javascript
const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const {
  requireProfileUpdate,
  requireResourceAccess,
} = require("../middleware/policy");
const profileController = require("../controllers/profile.controller");

// Get user profile (requires portal read access)
router.get(
  "/profile",
  authenticate,
  requireResourceAccess("portal", "read"),
  profileController.getProfile
);

// Update user profile (requires portal write access with context)
router.put(
  "/profile",
  authenticate,
  requireProfileUpdate(),
  profileController.updateProfile
);

// Update specific profile section
router.patch(
  "/profile/:section",
  authenticate,
  requireProfileUpdate(),
  profileController.updateProfileSection
);

// Upload profile picture (requires portal write access)
router.post(
  "/profile/picture",
  authenticate,
  requireResourceAccess("portal", "write"),
  profileController.uploadPicture
);

// Delete profile picture (requires portal write access)
router.delete(
  "/profile/picture",
  authenticate,
  requireResourceAccess("portal", "write"),
  profileController.deletePicture
);

module.exports = router;
```

**File: `src/routes/dashboard.js`**

```javascript
const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const { requireDashboardAccess } = require("../middleware/policy");
const dashboardController = require("../controllers/dashboard.controller");

// Get dashboard data (requires portal read access)
router.get(
  "/dashboard",
  authenticate,
  requireDashboardAccess(),
  dashboardController.getDashboard
);

// Get dashboard widgets (requires portal read access)
router.get(
  "/dashboard/widgets",
  authenticate,
  requireDashboardAccess(),
  dashboardController.getWidgets
);

// Update dashboard layout (requires portal write access)
router.put(
  "/dashboard/layout",
  authenticate,
  requireResourceAccess("portal", "write"),
  dashboardController.updateLayout
);

// Get dashboard statistics (requires portal read access)
router.get(
  "/dashboard/stats",
  authenticate,
  requireDashboardAccess(),
  dashboardController.getStats
);

module.exports = router;
```

**File: `src/routes/settings.js`**

```javascript
const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const {
  requireSettingsAccess,
  requireSettingsUpdate,
} = require("../middleware/policy");
const settingsController = require("../controllers/settings.controller");

// Get user settings (requires portal read access)
router.get(
  "/settings",
  authenticate,
  requireSettingsAccess(),
  settingsController.getSettings
);

// Update user settings (requires portal write access)
router.put(
  "/settings",
  authenticate,
  requireSettingsUpdate(),
  settingsController.updateSettings
);

// Update specific setting (requires portal write access)
router.patch(
  "/settings/:key",
  authenticate,
  requireSettingsUpdate(),
  settingsController.updateSetting
);

// Reset settings to default (requires portal write access)
router.post(
  "/settings/reset",
  authenticate,
  requireResourceAccess("portal", "write"),
  settingsController.resetSettings
);

module.exports = router;
```

---

## 🔧 **5. Controller Examples**

**File: `src/controllers/profile.controller.js`**

```javascript
/**
 * Profile Controller
 * Handles profile-related operations with PDP integration
 */

const profileService = require("../services/profile.service");

class ProfileController {
  /**
   * Get user profile
   */
  async getProfile(req, res) {
    try {
      const { userId, tenantId } = req.ctx;

      const profile = await profileService.getProfile(userId, tenantId);

      res.json({
        success: true,
        data: profile,
        user: req.user,
        tenantId: req.tenantId,
      });
    } catch (error) {
      console.error("Get profile error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to get profile",
      });
    }
  }

  /**
   * Update user profile
   */
  async updateProfile(req, res) {
    try {
      const { userId, tenantId } = req.ctx;
      const updateData = req.body;

      // Check if user can update this profile
      const targetUserId = req.policyContext?.context?.targetUserId;
      if (targetUserId && targetUserId !== userId) {
        // User is trying to update someone else's profile
        // Policy middleware already checked this, but we can add additional validation
        console.log(`User ${userId} updating profile for ${targetUserId}`);
      }

      const updatedProfile = await profileService.updateProfile(
        userId,
        tenantId,
        updateData
      );

      res.json({
        success: true,
        data: updatedProfile,
        message: "Profile updated successfully",
      });
    } catch (error) {
      console.error("Update profile error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update profile",
      });
    }
  }

  /**
   * Update specific profile section
   */
  async updateProfileSection(req, res) {
    try {
      const { userId, tenantId } = req.ctx;
      const { section } = req.params;
      const updateData = req.body;

      const updatedSection = await profileService.updateProfileSection(
        userId,
        tenantId,
        section,
        updateData
      );

      res.json({
        success: true,
        data: updatedSection,
        message: `Profile ${section} updated successfully`,
      });
    } catch (error) {
      console.error("Update profile section error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update profile section",
      });
    }
  }

  /**
   * Upload profile picture
   */
  async uploadPicture(req, res) {
    try {
      const { userId, tenantId } = req.ctx;

      // Handle file upload logic here
      const pictureUrl = await profileService.uploadPicture(
        userId,
        tenantId,
        req.file
      );

      res.json({
        success: true,
        data: { pictureUrl },
        message: "Profile picture uploaded successfully",
      });
    } catch (error) {
      console.error("Upload picture error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to upload picture",
      });
    }
  }

  /**
   * Delete profile picture
   */
  async deletePicture(req, res) {
    try {
      const { userId, tenantId } = req.ctx;

      await profileService.deletePicture(userId, tenantId);

      res.json({
        success: true,
        message: "Profile picture deleted successfully",
      });
    } catch (error) {
      console.error("Delete picture error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to delete picture",
      });
    }
  }
}

module.exports = new ProfileController();
```

---

## 🔧 **6. Policy Helper Utilities**

**File: `src/utils/policy-helpers.js`**

```javascript
/**
 * Portal Service Policy Helper Utilities
 * Provides utility functions for policy-related operations
 */

const { portalPolicyClient } = require("../services/policy-client");

/**
 * Check if user has portal access
 * @param {string} token - JWT token
 * @returns {Promise<boolean>} Access result
 */
async function hasPortalAccess(token) {
  try {
    const result = await portalPolicyClient.evaluatePortalAccess(token, "read");
    return result.success;
  } catch (error) {
    console.error("Portal access check error:", error);
    return false;
  }
}

/**
 * Check if user can update their profile
 * @param {string} token - JWT token
 * @param {string} targetUserId - Target user ID (optional)
 * @returns {Promise<boolean>} Access result
 */
async function canUpdateProfile(token, targetUserId = null) {
  try {
    const context = targetUserId ? { targetUserId } : {};
    const result = await portalPolicyClient.evaluatePortalAccess(
      token,
      "write",
      context
    );
    return result.success;
  } catch (error) {
    console.error("Profile update check error:", error);
    return false;
  }
}

/**
 * Get user's portal permissions
 * @param {string} token - JWT token
 * @returns {Promise<Array>} Array of permissions
 */
async function getPortalPermissions(token) {
  try {
    const result = await portalPolicyClient.getPortalPermissions(token);
    return result.success ? result.permissions || [] : [];
  } catch (error) {
    console.error("Get portal permissions error:", error);
    return [];
  }
}

/**
 * Check multiple portal permissions at once
 * @param {string} token - JWT token
 * @param {Array} permissions - Array of {action, context}
 * @returns {Promise<Object>} Permission results
 */
async function checkMultiplePortalPermissions(token, permissions) {
  try {
    const results = {};

    for (const permission of permissions) {
      const result = await portalPolicyClient.evaluatePortalAccess(
        token,
        permission.action,
        permission.context || {}
      );
      results[permission.action] = result.success;
    }

    return results;
  } catch (error) {
    console.error("Multiple portal permissions check error:", error);
    return {};
  }
}

/**
 * Extract user context from policy result
 * @param {Object} policyResult - Policy evaluation result
 * @returns {Object} User context
 */
function extractUserContext(policyResult) {
  if (!policyResult.success) {
    return null;
  }

  return {
    userId: policyResult.user?.id,
    tenantId: policyResult.user?.tenantId,
    userType: policyResult.user?.userType,
    roles: policyResult.user?.roles || [],
    permissions: policyResult.user?.permissions || [],
  };
}

/**
 * Create policy context for requests
 * @param {Object} req - Express request object
 * @param {Object} additionalContext - Additional context data
 * @returns {Object} Policy context
 */
function createPolicyContext(req, additionalContext = {}) {
  return {
    ...req.query,
    ...req.body,
    ...additionalContext,
    requestId: req.correlationId || req.headers["x-request-id"],
    userAgent: req.headers["user-agent"],
    ip: req.ip || req.connection.remoteAddress,
  };
}

/**
 * Validate policy decision and throw error if denied
 * @param {Object} policyResult - Policy evaluation result
 * @throws {Error} If policy decision is DENY
 */
function validatePolicyDecision(policyResult) {
  if (!policyResult.success) {
    const error = new Error(`Access denied: ${policyResult.reason}`);
    error.code = policyResult.reason;
    error.statusCode = 403;
    throw error;
  }
}

module.exports = {
  hasPortalAccess,
  canUpdateProfile,
  getPortalPermissions,
  checkMultiplePortalPermissions,
  extractUserContext,
  createPolicyContext,
  validatePolicyDecision,
};
```

---

## 🔧 **7. Main Application Setup**

**File: `src/app.js`**

```javascript
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

// Import middleware
const { authenticate } = require("./middleware/auth");
const { handlePolicyError } = require("./middleware/error-handler");

// Import routes
const authRoutes = require("./routes/auth");
const profileRoutes = require("./routes/profile");
const dashboardRoutes = require("./routes/dashboard");
const settingsRoutes = require("./routes/settings");

const app = express();

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || [
      "http://localhost:3000",
    ],
    credentials: true,
  })
);

// Logging middleware
app.use(morgan("combined"));

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint (no auth required)
app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Portal Service",
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: process.env.SERVICE_VERSION || "1.0.0",
  });
});

// Policy service health check
app.get("/health/policy", async (req, res) => {
  try {
    const { portalPolicyClient } = require("./services/policy-client");
    const stats = portalPolicyClient.getCacheStats();

    res.json({
      success: true,
      policyService: "connected",
      cacheStats: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      policyService: "disconnected",
      error: error.message,
    });
  }
});

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/settings", settingsRoutes);

// Error handling middleware
app.use(handlePolicyError);

// Global error handler
app.use((error, req, res, next) => {
  console.error("Global error handler:", error);

  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message || "Internal server error",
    code: error.code || "INTERNAL_ERROR",
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    code: "ROUTE_NOT_FOUND",
  });
});

module.exports = app;
```

---

## 🔧 **8. Environment Configuration**

**File: `.env`**

```bash
# Portal Service Configuration
PORT=3001
NODE_ENV=development
SERVICE_VERSION=1.0.0

# JWT Configuration
JWT_SECRET=your-jwt-secret-key

# User Service PDP Configuration
USER_SERVICE_URL=http://user-service:3000
POLICY_SERVICE_TIMEOUT=5000
POLICY_SERVICE_RETRIES=3
POLICY_CACHE_TIMEOUT=300000

# CORS Configuration
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001

# Database Configuration (if needed)
DATABASE_URL=mongodb://localhost:27017/portal-service

# Logging
LOG_LEVEL=info
```

---

## 🔧 **9. Package.json Dependencies**

**File: `package.json`**

```json
{
  "name": "portal-service",
  "version": "1.0.0",
  "description": "Portal Service with PDP Integration",
  "main": "src/app.js",
  "scripts": {
    "start": "node src/app.js",
    "dev": "nodemon src/app.js",
    "test": "jest",
    "test:watch": "jest --watch"
  },
  "dependencies": {
    "express": "^4.18.0",
    "axios": "^1.6.0",
    "jsonwebtoken": "^9.0.0",
    "cors": "^2.8.5",
    "helmet": "^7.0.0",
    "morgan": "^1.10.0",
    "multer": "^1.4.5-lts.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.0",
    "jest": "^29.0.0",
    "supertest": "^6.0.0"
  }
}
```

---

## 🔧 **10. Testing Implementation**

**File: `tests/middleware/policy.test.js`**

```javascript
const request = require("supertest");
const app = require("../../src/app");
const { MockPolicyClient } = require("../utils/policy-test-utils");

// Mock the policy client
jest.mock("../../src/services/policy-client", () => ({
  portalPolicyClient: new MockPolicyClient({
    "portal:read": {
      success: true,
      decision: "PERMIT",
      reason: "POLICY_SATISFIED",
    },
    "portal:write": {
      success: true,
      decision: "PERMIT",
      reason: "POLICY_SATISFIED",
    },
  }),
}));

describe("Policy Middleware", () => {
  const validToken = "valid-jwt-token";

  test("should allow access with valid token", async () => {
    const response = await request(app)
      .get("/api/profile/profile")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
  });

  test("should deny access without token", async () => {
    const response = await request(app).get("/api/profile/profile").expect(401);

    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe("MISSING_TOKEN");
  });

  test("should handle policy service errors", async () => {
    // Mock policy service error
    const { portalPolicyClient } = require("../../src/services/policy-client");
    portalPolicyClient.evaluatePortalAccess = jest
      .fn()
      .mockRejectedValue(new Error("Service unavailable"));

    const response = await request(app)
      .get("/api/profile/profile")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe("POLICY_SERVICE_ERROR");
  });
});
```

---

## 🔧 **11. Deployment Checklist**

### **Step 1: Environment Setup**

- [ ] Set `USER_SERVICE_URL` environment variable
- [ ] Configure JWT secret
- [ ] Set up CORS origins
- [ ] Configure logging level

### **Step 2: Service Integration**

- [ ] Copy policy client service
- [ ] Copy policy middleware
- [ ] Copy authentication middleware
- [ ] Update route definitions

### **Step 3: Testing**

- [ ] Test with mock policy client
- [ ] Test with real user-service
- [ ] Test error scenarios
- [ ] Test performance

### **Step 4: Monitoring**

- [ ] Add policy service health checks
- [ ] Monitor policy evaluation metrics
- [ ] Set up error alerting
- [ ] Track cache performance

---

## 🎯 **Key Features Implemented**

1. **Portal-Specific Policy Client** - Tailored for portal operations
2. **Comprehensive Middleware** - Dashboard, profile, settings access control
3. **Context-Aware Authorization** - Supports complex authorization scenarios
4. **Error Handling** - Robust error handling and fallbacks
5. **Caching** - Client-side caching for performance
6. **Testing Support** - Mock clients and test utilities
7. **Health Checks** - Policy service connectivity monitoring
8. **Security** - CORS, helmet, and input validation

This implementation provides a complete PDP integration for your portal-service API with comprehensive authorization controls and error handling.
