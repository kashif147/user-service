const crypto = require("crypto");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const Lookup = require("../models/lookup.model");
const LookupType = require("../models/lookupType.model");
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
 * Generate ETag for user data
 */
const generateETag = (userData) => {
  const dataString = JSON.stringify(userData);
  return `"${crypto.createHash("md5").update(dataString).digest("hex")}"`;
};

// Lookup types a CRM officer can be assigned to (via Lookup.officer).
// Matched by code, with the type name as a fallback (same as
// lookup.controller.js's isWorkLocationLookupType).
const ASSIGNED_LOCATION_TYPES = [
  { key: "regions", code: "REGION", name: "region" },
  { key: "branches", code: "BRANCH", name: "branch" },
  { key: "workLocations", code: "WORKLOC", name: "work location" },
];

const resolveAssignedLocationKey = (lookupType) => {
  const code = String(lookupType?.code || "").toUpperCase();
  const name = String(lookupType?.lookuptype || "")
    .trim()
    .toLowerCase();
  const match = ASSIGNED_LOCATION_TYPES.find(
    (t) => t.code === code || t.name === name,
  );
  return match ? match.key : null;
};

/**
 * Regions / branches / work locations the CRM user is assigned to as officer
 */
const getAssignedLocations = async (userId) => {
  const assigned = { regions: [], branches: [], workLocations: [] };

  const lookupTypes = await LookupType.find({
    $or: [
      { code: { $in: ASSIGNED_LOCATION_TYPES.map((t) => t.code) } },
      {
        lookuptype: {
          $in: ASSIGNED_LOCATION_TYPES.map(
            (t) => new RegExp(`^\\s*${t.name}\\s*$`, "i"),
          ),
        },
      },
    ],
    isdeleted: { $ne: true },
  })
    .select("code lookuptype")
    .lean();

  if (lookupTypes.length === 0) return assigned;

  const keyByTypeId = new Map();
  lookupTypes.forEach((type) => {
    const key = resolveAssignedLocationKey(type);
    if (key) keyByTypeId.set(type._id.toString(), key);
  });

  const lookups = await Lookup.find({
    officer: userId,
    lookuptypeId: { $in: [...keyByTypeId.keys()] },
    isdeleted: false,
    isactive: true,
  })
    .populate({ path: "Parentlookupid", select: "code lookupname" })
    .select("code lookupname DisplayName lookuptypeId Parentlookupid")
    .sort({ lookupname: 1 })
    .lean();

  lookups.forEach((lookup) => {
    const key = keyByTypeId.get(lookup.lookuptypeId?.toString());
    if (!key) return;
    const parent = lookup.Parentlookupid;
    assigned[key].push({
      id: lookup._id.toString(),
      code: lookup.code,
      lookupname: lookup.lookupname,
      DisplayName: lookup.DisplayName ?? null,
      lookuptypeId: lookup.lookuptypeId.toString(),
      parentLookupId: parent?._id ? parent._id.toString() : null,
      parentLookupName: parent?.lookupname ?? null,
    });
  });

  return assigned;
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

    // Check If-None-Match header for 304 responses
    const ifNoneMatch = req.headers["if-none-match"];
    if (cachedData && ifNoneMatch && cachedData.etag === ifNoneMatch) {
      res.set("ETag", cachedData.etag);
      res.set("X-Policy-Version", cachedData.policyVersion.toString());
      return res.status(304).end();
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
          select: "name code description category isActive",
        })
        .select(
          "userEmail userFirstName userLastName userFullName userMobilePhone userType tenantId isActive createdAt",
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

        // Collect all permission codes from roles
        const permissionCodes = rolePermissions.reduce((acc, role) => {
          if (role.permissions && role.permissions.length > 0) {
            acc.push(...role.permissions);
          }
          return acc;
        }, []);

        // Remove duplicates
        const uniquePermissionCodes = [...new Set(permissionCodes)];

        // Fetch actual permission details from Permission collection
        if (uniquePermissionCodes.length > 0) {
          const permissionDocs = await Permission.find({
            code: { $in: uniquePermissionCodes },
            isActive: true,
          }).select("code name description resource action category");

          permissions = permissionDocs.map((perm) => ({
            code: perm.code,
            name: perm.name,
            description: perm.description,
            resource: perm.resource,
            action: perm.action,
            category: perm.category,
          }));
        }
      }

      userData = {
        id: user._id.toString(),
        userEmail: user.userEmail,
        userFirstName: user.userFirstName,
        userLastName: user.userLastName,
        userFullName: user.userFullName,
        userMobilePhone: user.userMobilePhone,
        userType: user.userType,
        tenantId: user.tenantId,
        roles: activeRoles.map((role) => ({
          code: role.code,
          name: role.name,
          description: role.description,
          category: role.category,
        })),
        permissions,
        isActive: user.isActive,
        memberSince: user.createdAt,
      };

      if (user.userType === "CRM") {
        userData.assignedLocations = await getAssignedLocations(user._id);
      }
    }

    // Generate ETag
    const etag = generateETag(userData);
    const policyVersion = getPolicyVersion();

    // Cache the result
    if (meCache.enabled) {
      try {
        await meCache.set(cacheKey, {
          data: userData,
          etag,
          policyVersion,
          timestamp: new Date().toISOString(),
        });
      } catch (cacheError) {
        console.warn("Cache write error:", cacheError.message);
      }
    }

    // Set headers
    res.set("ETag", etag);
    res.set("X-Policy-Version", policyVersion.toString());
    res.set("Cache-Control", "private, max-age=300"); // 5 minutes

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
      AppError.internalServerError("Failed to retrieve user profile"),
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
