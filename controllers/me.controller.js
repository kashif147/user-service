const crypto = require("crypto");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const PolicyCache = require("../services/policyCache");
const { AppError } = require("../errors/AppError");

// Initialize cache for /me endpoint
const meCache = new PolicyCache({
  enabled: process.env.REDIS_ENABLED !== "false",
  ttl: parseInt(process.env.ME_CACHE_TTL) || 300, // 5 minutes default
  prefix: "me:",
});

// Initialize cache on startup
meCache.initialize().catch((err) => {
  console.error("Failed to initialize /me cache:", err);
});

// Policy version management
let POLICY_VERSION = parseInt(process.env.POLICY_VERSION) || 1;

/**
 * Get current policy version
 */
const getPolicyVersion = () => POLICY_VERSION;

/**
 * Increment policy version (called on admin changes)
 */
const incrementPolicyVersion = () => {
  POLICY_VERSION += 1;
  console.log(`Policy version incremented to: ${POLICY_VERSION}`);
};

/**
 * Get user profile with minimal data for /me endpoint
 */
const getMeProfile = async (req, res, next) => {
  try {
    const correlationId =
      req.headers["x-correlation-id"] || crypto.randomUUID();
    const { tenantId, userId } = req.ctx;

    // Validate tenant isolation
    if (!tenantId || !userId) {
      const error = AppError.badRequest("Missing tenant or user context", {
        authError: true,
        missingContext: true,
      });
      return res.status(error.status).json({
        error: {
          message: error.message,
          code: error.code,
          status: error.status,
          correlationId,
        },
      });
    }

    // Generate cache key with tenant isolation
    const cacheKey = `user:${tenantId}:${userId}`;

    // Check cache first
    let cachedData = null;
    if (meCache.enabled) {
      try {
        cachedData = await meCache.get(cacheKey);
      } catch (cacheError) {
        console.warn("Cache read error:", cacheError.message);
      }
    }

    let userData;

    if (cachedData && cachedData.data) {
      // Use cached data
      userData = cachedData.data;
    } else {
      // Fetch from database with tenant isolation
      const user = await User.findOne({
        _id: userId,
        tenantId,
        isActive: true,
      })
        .populate({
          path: "roles",
          match: { isActive: true },
          select: "name code description category",
        })
        .select(
          "userEmail userFirstName userLastName userFullName userType tenantId isActive createdAt"
        );

      if (!user) {
        const error = AppError.badRequest("User not found or inactive", {
          authError: true,
          userNotFound: true,
        });
        return res.status(error.status).json({
          error: {
            message: error.message,
            code: error.code,
            status: error.status,
            correlationId,
          },
        });
      }

      // Validate tenant isolation
      if (user.tenantId.toString() !== tenantId) {
        const error = AppError.badRequest("Tenant mismatch", {
          authError: true,
          tenantMismatch: true,
        });
        return res.status(403).json({
          error: {
            message: "TENANT_MISMATCH",
            code: "TENANT_MISMATCH",
            status: 403,
            correlationId,
          },
        });
      }

      // Build minimal user profile
      const activeRoles = user.roles.filter((role) => role.isActive);
      const roleCodes = activeRoles.map((role) => role.code);

      // Get permissions for active roles
      let permissions = [];
      if (roleCodes.length > 0) {
        const rolePermissions = await Role.find({
          tenantId,
          code: { $in: roleCodes },
          isActive: true,
        }).select("permissions");

        permissions = rolePermissions.reduce((acc, role) => {
          if (role.permissions) {
            acc.push(...role.permissions);
          }
          return acc;
        }, []);
      }

      userData = {
        id: user._id.toString(),
        email: user.userEmail,
        firstName: user.userFirstName,
        lastName: user.userLastName,
        fullName: user.userFullName,
        userType: user.userType,
        tenantId: user.tenantId,
        roles: activeRoles.map((role) => ({
          code: role.code,
          name: role.name,
          description: role.description,
          category: role.category,
        })),
        permissions: [...new Set(permissions)], // Remove duplicates
        isActive: user.isActive,
        memberSince: user.createdAt,
      };
    }

    const policyVersion = getPolicyVersion();

    // Cache the result
    if (meCache.enabled) {
      try {
        await meCache.set(cacheKey, {
          data: userData,
          policyVersion,
          timestamp: new Date().toISOString(),
        });
      } catch (cacheError) {
        console.warn("Cache write error:", cacheError.message);
      }
    }

    // Set headers (no ETag to prevent 304 responses)
    res.set("X-Policy-Version", policyVersion.toString());
    res.set("Cache-Control", "no-cache, no-store, must-revalidate"); // Prevent caching

    // Return minimal user profile
    res.status(200).json({
      success: true,
      data: userData,
      policyVersion,
      correlationId,
    });
  } catch (error) {
    console.error("Get /me profile error:", error);
    const correlationId =
      req.headers["x-correlation-id"] || crypto.randomUUID();

    return next(
      AppError.internalServerError("Failed to retrieve user profile")
    );
  }
};

/**
 * Invalidate /me cache for a specific user or all users
 */
const invalidateMeCache = async (tenantId = null, userId = null) => {
  if (!meCache.enabled) return;

  try {
    if (tenantId && userId) {
      // Invalidate specific user
      const cacheKey = `user:${tenantId}:${userId}`;
      await meCache.del(cacheKey);
    } else if (tenantId) {
      // Invalidate all users for a tenant
      const pattern = `user:${tenantId}:*`;
      await meCache.delPattern(pattern);
    } else {
      // Invalidate all /me cache
      const pattern = "user:*";
      await meCache.delPattern(pattern);
    }

    // Increment policy version
    incrementPolicyVersion();
  } catch (error) {
    console.error("Cache invalidation error:", error);
  }
};

module.exports = {
  getMeProfile,
  invalidateMeCache,
  getPolicyVersion,
  incrementPolicyVersion,
};
