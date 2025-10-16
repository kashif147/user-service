/**
 * Centralized RBAC Policy Middleware
 * Uses shared policy middleware package
 */

const {
  createDefaultPolicyMiddleware,
} = require("@membership/policy-middleware");

// Create default policy middleware instance
const defaultPolicyMiddleware = createDefaultPolicyMiddleware(
  process.env.POLICY_SERVICE_URL || "http://localhost:3000",
  {
    timeout: 15000, // Increased timeout for Azure
    retries: 5, // More retries for Azure
    cacheTimeout: 300000, // 5 minutes
    retryDelay: 2000, // Base delay between retries
  }
);

module.exports = defaultPolicyMiddleware;
module.exports.defaultPolicyMiddleware = defaultPolicyMiddleware;
