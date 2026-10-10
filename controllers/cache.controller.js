/**
 * Cache Management Controller
 *
 * Provides endpoints for managing Redis cache operations
 * including clearing, refreshing, and monitoring cache status
 *
 * Phase 1C-2R: error paths used res.fail(), which response.mw.js never defined (each one crashed
 * the process). They now use response.mw.js helpers; 500s are generic and the underlying
 * Redis/service error is only logged.
 */

const roleHierarchyService = require("../services/roleHierarchyService");
const permissionsService = require("../services/permissionsService");
const cacheService = require("../services/cacheService");
const lookupCacheService = require("../services/lookupCacheService");

// Clear all caches
module.exports.clearAllCaches = async (req, res) => {
  try {
    console.log("🧹 Clearing all caches...");

    // Clear role hierarchy cache
    await roleHierarchyService.clearCache();

    // Clear permissions cache
    await permissionsService.clearCache();

    // Clear Redis cache
    await cacheService.clear();

    // Clear lookup caches
    await lookupCacheService.clearAllCaches();

    res.success({
      message: "All caches cleared successfully",
      timestamp: new Date().toISOString(),
      clearedCaches: [
        "role_hierarchy",
        "permissions_map",
        "role_permissions",
        "redis_cache",
        "lookup_cache",
        "lookuptype_cache",
        "country_cache",
        "hierarchy_cache",
        "lookuptype_hierarchy_cache",
      ],
    });
  } catch (error) {
    console.error("Cache clear error:", error);
    return res.sendInternalError("Failed to clear caches");
  }
};

// Refresh role hierarchy cache
module.exports.refreshRoleHierarchyCache = async (req, res) => {
  try {
    console.log("🔄 Refreshing role hierarchy cache...");

    const hierarchy = await roleHierarchyService.refreshCache();

    res.success({
      message: "Role hierarchy cache refreshed successfully",
      timestamp: new Date().toISOString(),
      hierarchyCount: Object.keys(hierarchy).length,
      hierarchy: hierarchy,
    });
  } catch (error) {
    console.error("Role hierarchy cache refresh error:", error);
    return res.sendInternalError("Failed to refresh role hierarchy cache");
  }
};

// Refresh permissions cache
module.exports.refreshPermissionsCache = async (req, res) => {
  try {
    console.log("🔄 Refreshing permissions cache...");

    const permissions = await permissionsService.refreshCache();

    res.success({
      message: "Permissions cache refreshed successfully",
      timestamp: new Date().toISOString(),
      permissionsCount: permissions.length,
      permissions: permissions,
    });
  } catch (error) {
    console.error("Permissions cache refresh error:", error);
    return res.sendInternalError("Failed to refresh permissions cache");
  }
};

// Get cache statistics
module.exports.getCacheStats = async (req, res) => {
  try {
    console.log("📊 Getting cache statistics...");

    const redisStats = await cacheService.getStats();
    const roleHierarchy = await roleHierarchyService.getRoleHierarchy();
    const permissions = await permissionsService.getAllPermissions();
    const lookupStats = await lookupCacheService.getCacheStats();

    res.success({
      message: "Cache statistics retrieved successfully",
      timestamp: new Date().toISOString(),
      stats: {
        redis: redisStats,
        roleHierarchy: {
          cached: Object.keys(roleHierarchy).length > 0,
          roleCount: Object.keys(roleHierarchy).length,
        },
        permissions: {
          cached: permissions.length > 0,
          permissionCount: permissions.length,
        },
        lookup: lookupStats,
      },
    });
  } catch (error) {
    console.error("Cache stats error:", error);
    return res.sendInternalError("Failed to get cache statistics");
  }
};

// Get role hierarchy
module.exports.getRoleHierarchy = async (req, res) => {
  try {
    const hierarchy = await roleHierarchyService.getRoleHierarchy();

    res.success({
      message: "Role hierarchy retrieved successfully",
      timestamp: new Date().toISOString(),
      hierarchy: hierarchy,
    });
  } catch (error) {
    console.error("Role hierarchy error:", error);
    return res.sendInternalError("Failed to get role hierarchy");
  }
};

// Get permissions map
module.exports.getPermissionsMap = async (req, res) => {
  try {
    const permissionsMap = await permissionsService.getPermissionsMap();

    res.success({
      message: "Permissions map retrieved successfully",
      timestamp: new Date().toISOString(),
      permissionsMap: permissionsMap,
    });
  } catch (error) {
    console.error("Permissions map error:", error);
    return res.sendInternalError("Failed to get permissions map");
  }
};

// Get role permissions
module.exports.getRolePermissions = async (req, res) => {
  try {
    const { roleCode } = req.params;

    if (!roleCode) {
      return res.sendBadRequest("Role code is required");
    }

    const permissions = await permissionsService.getRolePermissions(roleCode);

    res.success({
      message: `Permissions for role ${roleCode} retrieved successfully`,
      timestamp: new Date().toISOString(),
      roleCode: roleCode,
      permissions: permissions,
    });
  } catch (error) {
    console.error("Role permissions error:", error);
    return res.sendInternalError("Failed to get role permissions");
  }
};

// Test cache performance
module.exports.testCachePerformance = async (req, res) => {
  try {
    console.log("⚡ Testing cache performance...");

    const iterations = 100;
    const startTime = Date.now();

    // Test role hierarchy cache performance
    for (let i = 0; i < iterations; i++) {
      await roleHierarchyService.getRoleHierarchy();
    }

    const endTime = Date.now();
    const totalTime = endTime - startTime;
    const avgTime = totalTime / iterations;

    res.success({
      message: "Cache performance test completed",
      timestamp: new Date().toISOString(),
      performance: {
        iterations: iterations,
        totalTime: `${totalTime}ms`,
        averageTime: `${avgTime.toFixed(2)}ms`,
        cacheType: "role_hierarchy",
      },
    });
  } catch (error) {
    console.error("Cache performance test error:", error);
    return res.sendInternalError("Failed to test cache performance");
  }
};

// Clear lookup caches
module.exports.clearLookupCaches = async (req, res) => {
  try {
    console.log("🧹 Clearing lookup caches...");

    await lookupCacheService.clearAllCaches();

    res.success({
      message: "Lookup caches cleared successfully",
      timestamp: new Date().toISOString(),
      clearedCaches: ["lookup_cache", "lookuptype_cache"],
    });
  } catch (error) {
    console.error("Lookup cache clear error:", error);
    return res.sendInternalError("Failed to clear lookup caches");
  }
};

// Get lookup cache statistics
module.exports.getLookupCacheStats = async (req, res) => {
  try {
    console.log("📊 Getting lookup cache statistics...");

    const stats = await lookupCacheService.getCacheStats();

    res.success({
      message: "Lookup cache statistics retrieved successfully",
      timestamp: new Date().toISOString(),
      stats: stats,
    });
  } catch (error) {
    console.error("Lookup cache stats error:", error);
    return res.sendInternalError("Failed to get lookup cache statistics");
  }
};

// Clear country caches
module.exports.clearCountryCaches = async (req, res) => {
  try {
    console.log("🧹 Clearing country caches...");

    await lookupCacheService.invalidateCountryCache();

    res.success({
      message: "Country caches cleared successfully",
      timestamp: new Date().toISOString(),
      clearedCaches: ["country_cache"],
    });
  } catch (error) {
    console.error("Country cache clear error:", error);
    return res.sendInternalError("Failed to clear country caches");
  }
};
