const { jwtVerify, createRemoteJWKSet } = require("jose");
const azureB2CConfig = require("../config/azure-b2c");
const Tenant = require("../models/tenant.model");
const User = require("../models/user.model"); // Use standard User model
const { generateToken } = require("../helpers/jwt");
const crypto = require("crypto");

/**
 * Find Tenant document by Azure B2C directory ID
 * @param {string} directoryId - Microsoft B2C directory ID (tid or extension_tenantId from token)
 * @returns {Promise<Object|null>} Tenant document or null
 */
async function findTenantByB2CDirectoryId(directoryId) {
  try {
    console.log("=== Looking up Tenant by Azure B2C directory ID ===");
    console.log("Directory ID from Microsoft:", directoryId);
    
    const tenant = await Tenant.findOne({
      "authenticationConnections.connectionType": "Azure B2C",
      "authenticationConnections.directoryId": directoryId,
      "authenticationConnections.isActive": true,
    });

    if (tenant) {
      console.log("✅ Found Tenant:", {
        _id: tenant._id.toString(),
        name: tenant.name,
        code: tenant.code,
      });
      console.log("📌 This Tenant._id will be used as tenantId in user document and JWT token");
      return tenant;
    } else {
      console.log("❌ No Tenant found for Azure B2C directory ID:", directoryId);
      console.log("💡 Make sure Tenant document has:");
      console.log("   - authenticationConnections.connectionType = 'Azure B2C'");
      console.log("   - authenticationConnections.directoryId =", directoryId);
      return null;
    }
  } catch (error) {
    console.error("Error looking up Tenant:", error.message);
    return null;
  }
}

class SessionsController {
  // POST /sessions
  async createSession(req, res) {
    try {
      const { id_token } = req.body;

      if (!id_token) {
        return res.status(400).json({
          success: false,
          error: {
            message: "Missing id_token in request body",
            code: "MISSING_ID_TOKEN",
          },
        });
      }

      // Validate B2C ID token
      const tokenPayload = await this.validateB2CToken(id_token);

      // Map B2C claims to internal user (with tenant lookup)
      const internalUserData = await this.mapB2CToInternalUser(tokenPayload);

      // CRITICAL: Fetch or create actual User from database
      // This ensures we have a proper User object with _id, userEmail, etc.
      // Required for generateToken() to work correctly
      const user = await this.findOrCreateB2CUser(internalUserData, tokenPayload);

      // CRITICAL: Use canonical JWT generation (single source of truth)
      // This ensures all tokens have the same structure: id, tenantId, roles, permissions
      const { token: internalJwt } = await generateToken(user);

      // Return session data
      res.json({
        success: true,
        data: {
          jwt: internalJwt,
          profile: {
            sub: user._id.toString(),
            id: user._id.toString(),
            email: user.userEmail,
            name: user.userName || user.userEmail,
            roles: user.roles || [],
            tenantId: user.tenantId.toString(),
          },
        },
      });
    } catch (error) {
      console.error("Error in createSession:", error.message);

      let statusCode = 500;
      let errorCode = "SESSION_CREATION_FAILED";

      if (error.message.includes("validation")) {
        statusCode = 401;
        errorCode = "TOKEN_VALIDATION_FAILED";
      } else if (error.message.includes("expired")) {
        statusCode = 401;
        errorCode = "TOKEN_EXPIRED";
      }

      res.status(statusCode).json({
        success: false,
        error: {
          message: error.message,
          code: errorCode,
        },
      });
    }
  }

  async validateB2CToken(idToken) {
    try {
      // Create JWKS client for B2C
      const JWKS = createRemoteJWKSet(new URL(azureB2CConfig.jwksUrl));

      // Verify the B2C token
      const { payload } = await jwtVerify(idToken, JWKS, {
        issuer: `https://${azureB2CConfig.tenantName}.b2clogin.com/${azureB2CConfig.tenantId}/v2.0/`,
        audience: azureB2CConfig.clientId,
      });

      console.log("\n");
      console.log("╔════════════════════════════════════════════════════════════════╗");
      console.log("║   🔍 WHAT MICROSOFT SENDS WHEN USER LOGS IN (B2C)            ║");
      console.log("╚════════════════════════════════════════════════════════════════╝");
      console.log("\n");
      console.log("╔════════════════════════════════════════════════════════════════╗");
      console.log("║   📋 FULL B2C ID TOKEN PAYLOAD FROM MICROSOFT                 ║");
      console.log("╚════════════════════════════════════════════════════════════════╝");
      console.log(JSON.stringify(payload, null, 2));
      console.log("\n");
      console.log("╔════════════════════════════════════════════════════════════════╗");
      console.log("║   🔑 KEY FIELDS FROM MICROSOFT                                ║");
      console.log("╚════════════════════════════════════════════════════════════════╝");
      // Extract directory ID from issuer URL if not in token
      // B2C issuer format: https://tenantname.b2clogin.com/{directoryId}/v2.0/
      let directoryIdFromIss = null;
      if (payload.iss) {
        const issMatch = payload.iss.match(/b2clogin\.com\/([a-f0-9-]+)\/v2\.0/);
        if (issMatch) {
          directoryIdFromIss = issMatch[1];
        }
      }

      console.log({
        "Directory ID (tid)": payload.tid || "NOT PRESENT",
        "Extension Tenant ID": payload.extension_tenantId || "NOT PRESENT",
        "Tenant ID": payload.tenantId || "NOT PRESENT",
        "Directory ID from Issuer URL": directoryIdFromIss || "NOT FOUND",
        "User ID (oid)": payload.oid,
        "Email": payload.email || payload.emails?.[0],
        "Name": payload.name || payload.given_name,
        "Issuer": payload.iss,
        "Audience": payload.aud,
      });
      console.log("\n=== ALL PAYLOAD KEYS ===");
      console.log(Object.keys(payload));

      // Validate policy
      if (!azureB2CConfig.allowedPolicies.includes(payload.tfp)) {
        throw new Error(`Invalid policy: ${payload.tfp}`);
      }

      // Validate required claims
      if (!payload.oid || !payload.email) {
        throw new Error("Missing required claims: oid or email");
      }

      return payload;
    } catch (error) {
      throw new Error(`B2C token validation failed: ${error.message}`);
    }
  }

  async mapB2CToInternalUser(tokenPayload) {
    // Use oid as stable user ID
    const internalUserId = `b2c_${tokenPayload.oid}`;

    // Extract Microsoft directory ID from B2C token
    // B2C may have it in tid, extension_tenantId, or embedded in iss URL
    let extractedDirectoryId =
      tokenPayload.tid ||
      tokenPayload.extension_tenantId ||
      tokenPayload.tenantId ||
      null;

    // If not in token fields, extract from issuer URL
    // Format: https://tenantname.b2clogin.com/{directoryId}/v2.0/
    if (!extractedDirectoryId && tokenPayload.iss) {
      const issMatch = tokenPayload.iss.match(/b2clogin\.com\/([a-f0-9-]+)\/v2\.0/);
      if (issMatch) {
        extractedDirectoryId = issMatch[1];
        console.log("✅ Extracted directory ID from issuer URL:", extractedDirectoryId);
      }
    }

    console.log("=== B2C Tenant Lookup ===");
    console.log("Extracted Microsoft directory ID:", extractedDirectoryId);

    if (!extractedDirectoryId) {
      console.error("❌ ERROR: No directory ID found in B2C token");
      throw new Error("Directory ID not found in B2C token");
    }

    // Look up Tenant document by directory ID
    const tenant = await findTenantByB2CDirectoryId(extractedDirectoryId);

    if (!tenant) {
      console.error("❌ ERROR: No Tenant found for directory ID:", extractedDirectoryId);
      console.error("Please ensure Tenant document exists with matching authenticationConnections");
      throw new Error(`Tenant not found for Azure B2C directory: ${extractedDirectoryId}`);
    }

    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║   ✅ TENANT MAPPING RESULT (B2C)                               ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log("Microsoft Directory ID:", extractedDirectoryId);
    console.log("Tenant Document _id:", tenant._id.toString());
    console.log("📌 Using Tenant._id as tenantId in user document and JWT token");
    console.log("");

    return {
      sub: internalUserId,
      b2c_sub: tokenPayload.oid,
      email: tokenPayload.email,
      name: tokenPayload.name || tokenPayload.given_name || tokenPayload.email,
      // Use Tenant._id instead of Microsoft directory ID
      tenantId: tenant._id.toString(),
      // Store Microsoft directory ID separately for reference
      microsoftDirectoryId: extractedDirectoryId,
      roles: ["member"], // Default role
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
    };
  }

  /**
   * Find or create B2C user in database
   * CRITICAL: This ensures we have a proper User object for generateToken()
   * @param {Object} internalUserData - Mapped user data from B2C token
   * @param {Object} tokenPayload - Original B2C token payload
   * @returns {Promise<Object>} User document from database
   */
  async findOrCreateB2CUser(internalUserData, tokenPayload) {
    const email = internalUserData.email;
    const tenantId = internalUserData.tenantId;

    if (!email || !tenantId) {
      throw new Error("Missing email or tenantId for user lookup");
    }

    // Find existing user by email and tenantId
    let user = await User.findOne({
      userEmail: email,
      tenantId: tenantId,
    });

    if (!user) {
      // Create new user if not found
      console.log("Creating new B2C user:", email);
      user = new User({
        userEmail: email,
        userName: internalUserData.name,
        tenantId: tenantId,
        userType: "PORTAL",
        userAuthProvider: "azure-b2c",
        userLastLogin: new Date(),
      });
      await user.save();
      console.log("✅ New B2C user created:", user._id.toString());
    } else {
      // Update last login
      user.userLastLogin = new Date();
      await user.save();
    }

    return user;
  }

  /**
   * DEPRECATED: issueInternalJWT() - DO NOT USE
   * 
   * This method created inconsistent JWT tokens (missing permissions, using jose library).
   * 
   * All JWT generation must now go through helpers/jwt.js → generateToken()
   * to ensure canonical payload structure across the entire platform.
   * 
   * @deprecated Use generateToken() from helpers/jwt.js instead
   */
  async issueInternalJWT(userData) {
    throw new Error(
      "issueInternalJWT() is deprecated. Use generateToken() from helpers/jwt.js instead."
    );
  }
}

module.exports = new SessionsController();
