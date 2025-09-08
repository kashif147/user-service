#!/usr/bin/env node

/**
 * User Service Client Example
 *
 * This demonstrates how other services can consume tokens from the user service
 * for authentication and authorization.
 */

const axios = require("axios");

class UserServiceClient {
  constructor(baseUrl = "http://localhost:3000") {
    this.baseUrl = baseUrl;
  }

  /**
   * Validate a user token and get user context
   * @param {string} token - Bearer token from user service
   * @returns {Object} User context or null if invalid
   */
  async validateToken(token) {
    try {
      const response = await axios.get(`${this.baseUrl}/token/validate`, {
        headers: {
          Authorization: token,
        },
      });

      if (response.data.success && response.data.valid) {
        return {
          user: response.data.user,
          expiresAt: response.data.expiresAt,
          valid: true,
        };
      }
      return null;
    } catch (error) {
      console.error("Token validation failed:", error.message);
      return null;
    }
  }

  /**
   * Check if user has specific permission
   * @param {string} token - Bearer token
   * @param {string} permission - Permission to check
   * @returns {boolean} True if user has permission
   */
  async hasPermission(token, permission) {
    const userContext = await this.validateToken(token);
    if (!userContext) return false;

    return userContext.user.permissions.includes(permission);
  }

  /**
   * Check if user has specific role
   * @param {string} token - Bearer token
   * @param {string} roleCode - Role code to check
   * @returns {boolean} True if user has role
   */
  async hasRole(token, roleCode) {
    const userContext = await this.validateToken(token);
    if (!userContext) return false;

    return userContext.user.roles.some((role) => role.code === roleCode);
  }

  /**
   * Get user's tenant ID
   * @param {string} token - Bearer token
   * @returns {string|null} Tenant ID or null if invalid
   */
  async getTenantId(token) {
    const userContext = await this.validateToken(token);
    return userContext ? userContext.user.tenantId : null;
  }

  /**
   * Decode token for inspection (development/testing only)
   * @param {string} token - Bearer token
   * @returns {Object} Decoded token information
   */
  async decodeToken(token) {
    try {
      const response = await axios.post(`${this.baseUrl}/token/decode-token`, {
        token: token.replace("Bearer ", ""),
      });

      return response.data.success ? response.data : null;
    } catch (error) {
      console.error("Token decode failed:", error.message);
      return null;
    }
  }
}

// Example usage
async function demonstrateUsage() {
  console.log("🔧 User Service Client Example");
  console.log("===============================");

  const client = new UserServiceClient();

  // First, get a test token
  console.log("\n1️⃣ Getting test token...");
  const tokenResponse = await axios.post(
    "http://localhost:3000/token/generate-test",
    {
      userId: "demo-user-123",
      tenantId: "demo-tenant-456",
      email: "demo@example.com",
    }
  );

  if (!tokenResponse.data.success) {
    console.log("❌ Failed to get test token");
    return;
  }

  const token = tokenResponse.data.token;
  console.log("✅ Test token obtained");

  // Validate the token
  console.log("\n2️⃣ Validating token...");
  const userContext = await client.validateToken(token);
  if (userContext) {
    console.log("✅ Token is valid");
    console.log("👤 User:", userContext.user.email);
    console.log("🏢 Tenant:", userContext.user.tenantId);
    console.log(
      "👥 Roles:",
      userContext.user.roles.map((r) => r.name).join(", ")
    );
    console.log("🔐 Permissions:", userContext.user.permissions.join(", "));
  } else {
    console.log("❌ Token is invalid");
    return;
  }

  // Check permissions
  console.log("\n3️⃣ Checking permissions...");
  const hasReadProfile = await client.hasPermission(token, "read:profile");
  const hasUpdateProfile = await client.hasPermission(token, "update:profile");
  const hasAdminAccess = await client.hasPermission(token, "admin:access");

  console.log("📖 Can read profile:", hasReadProfile ? "✅" : "❌");
  console.log("✏️ Can update profile:", hasUpdateProfile ? "✅" : "❌");
  console.log("👑 Has admin access:", hasAdminAccess ? "✅" : "❌");

  // Check roles
  console.log("\n4️⃣ Checking roles...");
  const isMember = await client.hasRole(token, "MEMBER");
  const isAdmin = await client.hasRole(token, "ADMIN");

  console.log("👤 Is member:", isMember ? "✅" : "❌");
  console.log("👑 Is admin:", isAdmin ? "✅" : "❌");

  // Get tenant ID
  console.log("\n5️⃣ Getting tenant information...");
  const tenantId = await client.getTenantId(token);
  console.log("🏢 Tenant ID:", tenantId);

  // Decode token for inspection
  console.log("\n6️⃣ Decoding token for inspection...");
  const decoded = await client.decodeToken(token);
  if (decoded) {
    console.log("🎫 Token Type:", decoded.tokenType);
    console.log("⏰ Expired:", decoded.isExpired);
    console.log("📊 Raw Claims:", Object.keys(decoded.raw).join(", "));
  }

  console.log("\n🎉 User Service Client demonstration completed!");
  console.log("\n💡 Integration Tips:");
  console.log("- Use validateToken() for authentication");
  console.log("- Use hasPermission() for authorization");
  console.log("- Use hasRole() for role-based access control");
  console.log("- Use getTenantId() for multi-tenant applications");
  console.log("- Cache user context to reduce API calls");
}

// Run demonstration if this script is executed directly
if (require.main === module) {
  demonstrateUsage().catch(console.error);
}

module.exports = UserServiceClient;
