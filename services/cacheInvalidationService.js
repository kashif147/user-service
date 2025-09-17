const {
  invalidateMeCache,
  incrementPolicyVersion,
} = require("../controllers/me.controller");
const policyService = require("../services/policyEvaluationService");

/**
 * Cache Invalidation Service
 *
 * This service handles cache invalidation when admin changes occur.
 * It should be called whenever:
 * - User roles are modified
 * - Role permissions are updated
 * - User profile data changes
 * - Policy rules are modified
 */

/**
 * Invalidate cache for a specific user
 * @param {string} tenantId - Tenant ID
 * @param {string} userId - User ID
 */
const invalidateUserCache = async (tenantId, userId) => {
  try {
    console.log(
      `Invalidating cache for user: ${userId} in tenant: ${tenantId}`
    );

    // Invalidate /me cache
    await invalidateMeCache(tenantId, userId);

    // Invalidate policy cache
    await policyService.invalidateCache(tenantId);

    console.log(`Cache invalidated successfully for user: ${userId}`);
  } catch (error) {
    console.error("Error invalidating user cache:", error);
  }
};

/**
 * Invalidate cache for all users in a tenant
 * @param {string} tenantId - Tenant ID
 */
const invalidateTenantCache = async (tenantId) => {
  try {
    console.log(`Invalidating cache for all users in tenant: ${tenantId}`);

    // Invalidate all /me cache for tenant
    await invalidateMeCache(tenantId);

    // Invalidate policy cache for tenant
    await policyService.invalidateCache(tenantId);

    console.log(`Cache invalidated successfully for tenant: ${tenantId}`);
  } catch (error) {
    console.error("Error invalidating tenant cache:", error);
  }
};

/**
 * Invalidate all cache (use sparingly)
 */
const invalidateAllCache = async () => {
  try {
    console.log("Invalidating all cache");

    // Invalidate all /me cache
    await invalidateMeCache();

    // Invalidate all policy cache
    await policyService.invalidateCache();

    console.log("All cache invalidated successfully");
  } catch (error) {
    console.error("Error invalidating all cache:", error);
  }
};

/**
 * Handle role assignment changes
 * @param {string} tenantId - Tenant ID
 * @param {string} userId - User ID
 * @param {Array} newRoles - New roles assigned
 */
const handleRoleAssignmentChange = async (tenantId, userId, newRoles) => {
  console.log(`Role assignment changed for user: ${userId}`, newRoles);
  await invalidateUserCache(tenantId, userId);
};

/**
 * Handle role permission changes
 * @param {string} tenantId - Tenant ID
 * @param {string} roleCode - Role code
 * @param {Array} newPermissions - New permissions
 */
const handleRolePermissionChange = async (
  tenantId,
  roleCode,
  newPermissions
) => {
  console.log(`Role permissions changed for role: ${roleCode}`, newPermissions);
  await invalidateTenantCache(tenantId);
};

/**
 * Handle user profile changes
 * @param {string} tenantId - Tenant ID
 * @param {string} userId - User ID
 * @param {Object} changes - Profile changes
 */
const handleUserProfileChange = async (tenantId, userId, changes) => {
  console.log(`User profile changed for user: ${userId}`, changes);
  await invalidateUserCache(tenantId, userId);
};

/**
 * Handle policy rule changes
 * @param {string} tenantId - Tenant ID (null for global changes)
 */
const handlePolicyRuleChange = async (tenantId = null) => {
  console.log(`Policy rules changed for tenant: ${tenantId || "global"}`);

  if (tenantId) {
    await invalidateTenantCache(tenantId);
  } else {
    await invalidateAllCache();
  }
};

module.exports = {
  invalidateUserCache,
  invalidateTenantCache,
  invalidateAllCache,
  handleRoleAssignmentChange,
  handleRolePermissionChange,
  handleUserProfileChange,
  handlePolicyRuleChange,
};
