/**
 * Database-Driven Permissions Service
 *
 * This service provides permissions functionality by reading from the database
 * and caching results in Redis for performance. This replaces hardcoded constants
 * with dynamic, database-driven configuration.
 */

const Permission = require("../models/permission");
const Role = require("../models/role");
const cache = require("./cacheService");

class PermissionsService {
  constructor() {
    this.permissionsCacheKey = "permissions_map";
    this.rolePermissionsCacheKey = "role_permissions";
    this.cacheTimeout = 300000; // 5 minutes
  }

  /**
   * Get all permissions from database with Redis caching
   * @returns {Promise<Array>} Array of permission objects
   */
  async getAllPermissions() {
    try {
      // Try to get from cache first
      const cached = await cache.get(this.permissionsCacheKey);
      if (cached) {
        console.log("Permissions loaded from cache");
        return cached;
      }

      // Load from database
      console.log("Loading permissions from database...");
      const permissions = await Permission.find({ isActive: true })
        .select("code name resource action level category")
        .lean();

      // Cache the result
      await cache.set(this.permissionsCacheKey, permissions, this.cacheTimeout);

      console.log(`Permissions loaded: ${permissions.length} permissions`);
      return permissions;
    } catch (error) {
      console.error("Error loading permissions:", error);
      // Return fallback permissions on error
      return this.getFallbackPermissions();
    }
  }

  /**
   * Get permissions by resource
   * @param {string} resource - Resource name
   * @returns {Promise<Array>} Array of permissions for the resource
   */
  async getPermissionsByResource(resource) {
    const permissions = await this.getAllPermissions();
    return permissions.filter((p) => p.resource === resource);
  }

  /**
   * Get permissions by action
   * @param {string} action - Action name
   * @returns {Promise<Array>} Array of permissions for the action
   */
  async getPermissionsByAction(action) {
    const permissions = await this.getAllPermissions();
    return permissions.filter((p) => p.action === action);
  }

  /**
   * Get permission by code
   * @param {string} code - Permission code
   * @returns {Promise<Object|null>} Permission object or null
   */
  async getPermissionByCode(code) {
    const permissions = await this.getAllPermissions();
    return permissions.find((p) => p.code === code) || null;
  }

  /**
   * Get role permissions from database with Redis caching
   * @param {string} roleCode - Role code
   * @returns {Promise<Array>} Array of permission codes for the role
   */
  async getRolePermissions(roleCode) {
    try {
      const cacheKey = `${this.rolePermissionsCacheKey}:${roleCode}`;

      // Try to get from cache first
      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Load from database
      const role = await Role.findOne({ code: roleCode, isActive: true })
        .select("permissions")
        .lean();

      const permissions = role ? role.permissions : [];

      // Cache the result
      await cache.set(cacheKey, permissions, this.cacheTimeout);

      return permissions;
    } catch (error) {
      console.error(`Error loading permissions for role ${roleCode}:`, error);
      return [];
    }
  }

  /**
   * Get effective permissions for a user (combines all role permissions)
   * @param {Array} userRoles - Array of user roles
   * @returns {Promise<Array>} Array of unique permission codes
   */
  async getEffectivePermissions(userRoles) {
    if (!userRoles || !Array.isArray(userRoles)) return [];

    try {
      const allPermissions = new Set();

      for (const role of userRoles) {
        const rolePermissions = await this.getRolePermissions(
          role.code || role
        );
        rolePermissions.forEach((perm) => allPermissions.add(perm));
      }

      return Array.from(allPermissions);
    } catch (error) {
      console.error("Error getting effective permissions:", error);
      return [];
    }
  }

  /**
   * Check if user has specific permission
   * @param {Array} userRoles - Array of user roles
   * @param {string} permissionCode - Permission code to check
   * @returns {Promise<boolean>} True if user has permission
   */
  async hasPermission(userRoles, permissionCode) {
    const effectivePermissions = await this.getEffectivePermissions(userRoles);

    // Check for wildcard permission
    if (effectivePermissions.includes("*")) {
      return true;
    }

    return effectivePermissions.includes(permissionCode);
  }

  /**
   * Check if user has any of the specified permissions
   * @param {Array} userRoles - Array of user roles
   * @param {Array} permissionCodes - Array of permission codes to check
   * @returns {Promise<boolean>} True if user has any of the permissions
   */
  async hasAnyPermission(userRoles, permissionCodes) {
    const effectivePermissions = await this.getEffectivePermissions(userRoles);

    // Check for wildcard permission
    if (effectivePermissions.includes("*")) {
      return true;
    }

    return permissionCodes.some((code) => effectivePermissions.includes(code));
  }

  /**
   * Check if user has all of the specified permissions
   * @param {Array} userRoles - Array of user roles
   * @param {Array} permissionCodes - Array of permission codes to check
   * @returns {Promise<boolean>} True if user has all permissions
   */
  async hasAllPermissions(userRoles, permissionCodes) {
    const effectivePermissions = await this.getEffectivePermissions(userRoles);

    // Check for wildcard permission
    if (effectivePermissions.includes("*")) {
      return true;
    }

    return permissionCodes.every((code) => effectivePermissions.includes(code));
  }

  /**
   * Get permissions map grouped by resource
   * @returns {Promise<Object>} Object with resource as key and permissions as value
   */
  async getPermissionsMap() {
    try {
      const cacheKey = "permissions_map_grouped";

      // Try to get from cache first
      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const permissions = await this.getAllPermissions();
      const map = {};

      permissions.forEach((perm) => {
        if (!map[perm.resource]) {
          map[perm.resource] = [];
        }
        map[perm.resource].push({
          code: perm.code,
          name: perm.name,
          action: perm.action,
          level: perm.level,
          category: perm.category,
        });
      });

      // Cache the result
      await cache.set(cacheKey, map, this.cacheTimeout);

      return map;
    } catch (error) {
      console.error("Error creating permissions map:", error);
      return {};
    }
  }

  /**
   * Clear permissions cache
   */
  async clearCache() {
    await cache.del(this.permissionsCacheKey);
    await cache.del("permissions_map_grouped");

    // Clear all role permission caches
    const keys = await cache.keys(`${this.rolePermissionsCacheKey}:*`);
    if (keys.length > 0) {
      await cache.del(...keys);
    }

    console.log("Permissions cache cleared");
  }

  /**
   * Refresh permissions cache
   */
  async refreshCache() {
    await this.clearCache();
    return await this.getAllPermissions();
  }

  /**
   * Fallback permissions for when database is unavailable
   * @returns {Array} Fallback permissions array
   */
  getFallbackPermissions() {
    return [
      // User permissions
      {
        code: "USER_READ",
        name: "Read Users",
        resource: "user",
        action: "read",
        level: 1,
        category: "USER",
      },
      {
        code: "USER_WRITE",
        name: "Write Users",
        resource: "user",
        action: "write",
        level: 30,
        category: "USER",
      },
      {
        code: "USER_DELETE",
        name: "Delete Users",
        resource: "user",
        action: "delete",
        level: 60,
        category: "USER",
      },

      // Role permissions
      {
        code: "ROLE_READ",
        name: "Read Roles",
        resource: "role",
        action: "read",
        level: 1,
        category: "ROLE",
      },
      {
        code: "ROLE_WRITE",
        name: "Write Roles",
        resource: "role",
        action: "write",
        level: 30,
        category: "ROLE",
      },
      {
        code: "ROLE_DELETE",
        name: "Delete Roles",
        resource: "role",
        action: "delete",
        level: 60,
        category: "ROLE",
      },

      // Tenant permissions
      {
        code: "TENANT_READ",
        name: "Read Tenants",
        resource: "tenant",
        action: "read",
        level: 1,
        category: "TENANT",
      },
      {
        code: "TENANT_WRITE",
        name: "Write Tenants",
        resource: "tenant",
        action: "write",
        level: 80,
        category: "TENANT",
      },
      {
        code: "TENANT_DELETE",
        name: "Delete Tenants",
        resource: "tenant",
        action: "delete",
        level: 100,
        category: "TENANT",
      },

      // Lookup permissions
      {
        code: "LOOKUP_READ",
        name: "Read Lookups",
        resource: "lookup",
        action: "read",
        level: 1,
        category: "LOOKUP",
      },
      {
        code: "LOOKUP_WRITE",
        name: "Write Lookups",
        resource: "lookup",
        action: "write",
        level: 30,
        category: "LOOKUP",
      },
      {
        code: "LOOKUP_DELETE",
        name: "Delete Lookups",
        resource: "lookup",
        action: "delete",
        level: 60,
        category: "LOOKUP",
      },

      // LookupType permissions
      {
        code: "LOOKUPTYPE_READ",
        name: "Read Lookup Types",
        resource: "lookuptype",
        action: "read",
        level: 1,
        category: "LOOKUPTYPE",
      },
      {
        code: "LOOKUPTYPE_WRITE",
        name: "Write Lookup Types",
        resource: "lookuptype",
        action: "write",
        level: 30,
        category: "LOOKUPTYPE",
      },
      {
        code: "LOOKUPTYPE_DELETE",
        name: "Delete Lookup Types",
        resource: "lookuptype",
        action: "delete",
        level: 60,
        category: "LOOKUPTYPE",
      },
    ];
  }
}

// Create singleton instance
const permissionsService = new PermissionsService();

module.exports = permissionsService;
