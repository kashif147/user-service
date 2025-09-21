/**
 * Database-Driven Role Hierarchy Service
 *
 * This service provides role hierarchy functionality by reading from the database
 * and caching results in Redis for performance. This replaces hardcoded constants
 * with dynamic, database-driven configuration.
 */

const Role = require("../models/role.model");
const cache = require("./cacheService");

class RoleHierarchyService {
  constructor() {
    this.cacheKey = "role_hierarchy";
    this.cacheTimeout = 300000; // 5 minutes
  }

  /**
   * Get role hierarchy from database with Redis caching
   * @returns {Promise<Object>} Role hierarchy object
   */
  async getRoleHierarchy() {
    try {
      // Try to get from cache first
      const cached = await cache.get(this.cacheKey);
      if (cached) {
        console.log("Role hierarchy loaded from cache");
        return cached;
      }

      // Load from database
      console.log("Loading role hierarchy from database...");
      const roles = await Role.find({ isActive: true })
        .select("code level")
        .lean();

      // Build hierarchy object
      const hierarchy = {};
      roles.forEach((role) => {
        if (role.code && role.level !== undefined) {
          hierarchy[role.code] = role.level;
        }
      });

      // Add fallback hierarchy for roles without level
      const fallbackHierarchy = this.getFallbackHierarchy();
      const finalHierarchy = { ...fallbackHierarchy, ...hierarchy };

      // Cache the result
      await cache.set(this.cacheKey, finalHierarchy, this.cacheTimeout);

      console.log(
        `Role hierarchy loaded: ${Object.keys(finalHierarchy).length} roles`
      );
      return finalHierarchy;
    } catch (error) {
      console.error("Error loading role hierarchy:", error);
      // Return fallback hierarchy on error
      return this.getFallbackHierarchy();
    }
  }

  /**
   * Get privilege level for a role
   * @param {string} roleCode - The role code
   * @returns {Promise<number>} The privilege level
   */
  async getRoleLevel(roleCode) {
    const hierarchy = await this.getRoleHierarchy();
    return hierarchy[roleCode] || 0;
  }

  /**
   * Get highest privilege level from array of roles
   * @param {string[]} roles - Array of role codes
   * @returns {Promise<number>} Highest privilege level
   */
  async getHighestRoleLevel(roles) {
    if (!roles || !Array.isArray(roles)) return 0;

    const hierarchy = await this.getRoleHierarchy();
    return Math.max(...roles.map((role) => hierarchy[role] || 0));
  }

  /**
   * Check if user has minimum required role level
   * @param {string[]} userRoles - User's roles
   * @param {string} minRole - Minimum required role
   * @returns {Promise<boolean>} True if user has sufficient privileges
   */
  async hasMinimumRole(userRoles, minRole) {
    if (!userRoles || !Array.isArray(userRoles)) return false;

    const hierarchy = await this.getRoleHierarchy();
    const minLevel = hierarchy[minRole] || 0;
    const userMaxLevel = Math.max(
      ...userRoles.map((role) => hierarchy[role] || 0)
    );

    return userMaxLevel >= minLevel;
  }

  /**
   * Check if user has Super User privileges
   * @param {string[]} userRoles - User's roles
   * @returns {boolean} True if user is Super User
   */
  isSuperUser(userRoles) {
    return userRoles && userRoles.includes("SU");
  }

  /**
   * Check if user has Assistant Super User privileges
   * @param {string[]} userRoles - User's roles
   * @returns {boolean} True if user is Assistant Super User
   */
  isAssistantSuperUser(userRoles) {
    return userRoles && userRoles.includes("ASU");
  }

  /**
   * Check if user has Super User or Assistant Super User privileges
   * @param {string[]} userRoles - User's roles
   * @returns {boolean} True if user is SU or ASU
   */
  isSystemAdmin(userRoles) {
    return this.isSuperUser(userRoles) || this.isAssistantSuperUser(userRoles);
  }

  /**
   * Get all roles at or above a certain level
   * @param {number} minLevel - Minimum privilege level
   * @returns {Promise<string[]>} Array of role codes
   */
  async getRolesAtOrAbove(minLevel) {
    const hierarchy = await this.getRoleHierarchy();
    return Object.entries(hierarchy)
      .filter(([_, level]) => level >= minLevel)
      .map(([role, _]) => role);
  }

  /**
   * Get role hierarchy as sorted array
   * @returns {Promise<Array>} Array of {role, level} objects sorted by level
   */
  async getRoleHierarchySorted() {
    const hierarchy = await this.getRoleHierarchy();
    return Object.entries(hierarchy)
      .map(([role, level]) => ({ role, level }))
      .sort((a, b) => b.level - a.level);
  }

  /**
   * Clear role hierarchy cache
   */
  async clearCache() {
    await cache.del(this.cacheKey);
    console.log("Role hierarchy cache cleared");
  }

  /**
   * Refresh role hierarchy cache
   */
  async refreshCache() {
    await this.clearCache();
    return await this.getRoleHierarchy();
  }

  /**
   * Fallback hierarchy for when database is unavailable
   * @returns {Object} Fallback role hierarchy
   */
  getFallbackHierarchy() {
    return {
      // System Roles
      SU: 100,
      ASU: 95,

      // Executive Roles
      GS: 90,
      DGS: 85,

      // Director Level
      DIR: 80,
      DPRS: 80,
      ADIR: 75,

      // Management Level
      AM: 70,
      DAM: 65,
      MO: 60,
      AMO: 55,

      // Executive Level
      IRE: 50,
      IRO: 45,
      RO: 40,
      BO: 35,

      // Officer Level
      IO: 30,
      HLS: 25,
      CC: 15,
      ACC: 15,

      // Support Level
      LS: 10,
      LA: 5,
      AA: 5,

      // Basic Access
      REO: 1,
      MEMBER: 1,
      "NON-MEMBER": 1,
    };
  }
}

// Create singleton instance
const roleHierarchyService = new RoleHierarchyService();

module.exports = roleHierarchyService;
