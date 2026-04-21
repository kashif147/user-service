const axios = require("axios");
const B2CUser = require("../models/user.model");
const Tenant = require("../models/tenant.model");
const {
  syncPortalUserRolesFromMembership,
} = require("../helpers/portalRoleSync");
const {
  publishPortalUserCreated,
  publishPortalUserUpdated,
} = require("../rabbitMQ/publishers/user.portal.publisher");
const { buildUserTokensSubdocument } = require("../helpers/oauthTokenStorage");
const { b2cTokenEndpoint } = require("../helpers/b2cPolicy");

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
      console.log(
        "📌 This Tenant._id will be used as tenantId in user document and JWT token",
      );
      return tenant;
    } else {
      console.log(
        "❌ No Tenant found for Azure B2C directory ID:",
        directoryId,
      );
      console.log("💡 Make sure Tenant document has:");
      console.log(
        "   - authenticationConnections.connectionType = 'Azure B2C'",
      );
      console.log("   - authenticationConnections.directoryId =", directoryId);
      return null;
    }
  } catch (error) {
    console.error("Error looking up Tenant:", error.message);
    return null;
  }
}

const CLIENT_ID =
  process.env.MS_CLIENT_ID || "e3688a2f-3956-42f9-8c98-6fea7a60a5b4";
const REDIRECT_URI = process.env.MS_REDIRECT_URI || "http://localhost:3000";

class B2CUsersHandler {
  static async exchangeCodeForTokens(code, codeVerifier, policyName) {
    const tokenEndpoint = b2cTokenEndpoint(policyName);
    console.log("=== Token Exchange Debug ===");
    console.log("B2C policy (user flow):", policyName);
    console.log("Token Endpoint:", tokenEndpoint);
    console.log("Client ID:", CLIENT_ID);
    console.log("Redirect URI:", REDIRECT_URI);
    console.log("Code (first 50 chars):", code.substring(0, 50) + "...");
    console.log(
      "Code Verifier (first 20 chars):",
      codeVerifier.substring(0, 20) + "...",
    );

    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      scope: "openid offline_access",
    });

    console.log("Request data:", data.toString());

    try {
      console.log("🔄 Sending token exchange request...");
      const response = await axios.post(tokenEndpoint, data.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      console.log("✅ Token exchange successful");
      console.log("Response status:", response.status);
      console.log("Tokens received:", {
        id_token: response.data.id_token ? "Present" : "Missing",
        refresh_token: response.data.refresh_token ? "Present" : "Missing",
      });

      return response.data;
    } catch (error) {
      console.log("❌ Token exchange failed:", error.message);
      console.log("Error status:", error.response?.status);
      console.log("Error details:", error.response?.data);
      console.log("Full error:", error);
      throw error;
    }
  }

  static async decodeIdToken(idToken) {
    console.log("=== B2C decodeIdToken Debug ===");
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64").toString("utf8"),
    );

    console.log("=== FULL B2C ID TOKEN PAYLOAD FROM MICROSOFT ===");
    console.log(JSON.stringify(payload, null, 2));
    console.log("=== TENANT/DIRECTORY ID FIELDS FROM MICROSOFT ===");
    console.log({
      tenantId: payload.tenantId,
      extension_tenantId: payload.extension_tenantId,
      tid: payload.tid,
      iss: payload.iss,
      aud: payload.aud,
    });
    console.log("=== ALL PAYLOAD KEYS ===");
    console.log(Object.keys(payload));

    // Extract Microsoft directory ID from B2C token
    // B2C may have it in tid, extension_tenantId, or embedded in iss URL
    let extractedDirectoryId =
      payload.tid || payload.extension_tenantId || payload.tenantId || null;

    // If not in token fields, extract from issuer URL
    // Format: https://tenantname.b2clogin.com/{directoryId}/v2.0/
    if (!extractedDirectoryId && payload.iss) {
      const issMatch = payload.iss.match(/b2clogin\.com\/([a-f0-9-]+)\/v2\.0/);
      if (issMatch) {
        extractedDirectoryId = issMatch[1];
        console.log(
          "✅ Extracted directory ID from issuer URL:",
          extractedDirectoryId,
        );
      }
    }

    if (!extractedDirectoryId) {
      console.error("❌ ERROR: Could not extract directory ID from B2C token");
      throw new Error(
        "Directory ID not found in B2C token (checked tid, extension_tenantId, tenantId, and issuer URL)",
      );
    }

    console.log("Extracted Microsoft directory ID:", extractedDirectoryId);

    // Look up Tenant document by directory ID
    const tenant = await findTenantByB2CDirectoryId(extractedDirectoryId);

    if (!tenant) {
      console.error(
        "❌ ERROR: No Tenant found for directory ID:",
        extractedDirectoryId,
      );
      console.error(
        "Please ensure Tenant document exists with matching authenticationConnections",
      );
      throw new Error(
        `Tenant not found for Azure B2C directory: ${extractedDirectoryId}`,
      );
    }

    console.log("\n");
    console.log(
      "╔════════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "║   ✅ TENANT MAPPING RESULT (B2C)                               ║",
    );
    console.log(
      "╚════════════════════════════════════════════════════════════════╝",
    );
    console.log("Microsoft Directory ID:", extractedDirectoryId);
    console.log("Tenant Document _id:", tenant._id.toString());
    console.log(
      "📌 Using Tenant._id as tenantId in user document and JWT token",
    );
    console.log("");

    return {
      userEmail: payload.emails?.[0] || null,
      userFirstName: payload.given_name || null,
      userLastName: payload.family_name || null,
      userFullName: `${payload.given_name || ""} ${
        payload.family_name || ""
      }`.trim(),
      userMobilePhone: payload.extension_mobilePhone || null,
      userMemberNumber: payload.extension_MemberNo || null,
      userMicrosoftId: payload.oid || null,
      userSubject: payload.sub || null,
      userAudience: payload.aud || null,
      userIssuer: payload.iss || null,
      userIssuedAt: payload.iat || null,
      userAuthTime: payload.auth_time || null,
      userTokenVersion: payload.ver || null,
      userPolicy: payload.tfp || null,
      // Use Tenant._id instead of Microsoft directory ID
      tenantId: tenant._id.toString(),
      // Store Microsoft directory ID separately for reference
      microsoftDirectoryId: extractedDirectoryId,
    };
  }

  static async findOrCreateUser(profile, tokens) {
    console.log("Finding or creating user");
    console.log("User profile:", profile);

    const email = profile.userEmail;
    const tenantId = profile.tenantId;

    if (!email) {
      console.log("Email not found in profile");
      throw new Error("Email not found in Microsoft token");
    }

    if (!tenantId) {
      console.log("Tenant ID not found in profile");
      throw new Error("Tenant ID not found in Microsoft token");
    }

    const updateData = {
      ...profile,
      userAuthProvider: "microsoft",
      userType: "PORTAL", // Ensure portal users are marked as PORTAL type
      userLastLogin: new Date(),
      tenantId: tenantId,
      tokens: buildUserTokensSubdocument(tokens),
      updatedAt: new Date(),
    };

    try {
      // First, try to find existing user by email + new tenantId (Tenant._id)
      let existingUser = await B2CUser.findOne({
        userEmail: email,
        tenantId: tenantId,
      }).lean();

      // If not found, try to find by email only (for existing users created before tenant mapping)
      // This handles migration of existing users to new tenant mapping
      if (!existingUser) {
        console.log(
          "⚠️  User not found with new tenantId, checking for existing user by email only...",
        );
        existingUser = await B2CUser.findOne({
          userEmail: email,
        }).lean();

        if (existingUser) {
          console.log(
            "✅ Found existing user with old tenantId:",
            existingUser.tenantId,
          );
          console.log(
            "📌 Will update tenantId from",
            existingUser.tenantId,
            "to",
            tenantId,
          );
        }
      }

      const isNewUser = !existingUser;

      // Capture previous values for update event (before update)
      const previousValues = existingUser
        ? {
            userEmail: existingUser.userEmail,
            userFullName: existingUser.userFullName,
            userFirstName: existingUser.userFirstName,
            userLastName: existingUser.userLastName,
            userMobilePhone: existingUser.userMobilePhone,
            userMemberNumber: existingUser.userMemberNumber,
          }
        : {};

      // Use atomic findOneAndUpdate with upsert to prevent race conditions
      // If existing user found by email only, update their tenantId to new Tenant._id
      const user = await B2CUser.findOneAndUpdate(
        existingUser && existingUser.tenantId !== tenantId
          ? { userEmail: email } // Update existing user by email only
          : { userEmail: email, tenantId: tenantId }, // Normal case: email + tenantId
        {
          $set: updateData, // This includes the new tenantId (Tenant._id)
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
        },
      );

      await syncPortalUserRolesFromMembership(user, email, tenantId, {
        isNewUser,
      });

      if (isNewUser) {
        console.log("Creating new user");
        await publishPortalUserCreated(user);
      } else {
        console.log("Updating existing user");
        await publishPortalUserUpdated(user, previousValues);
      }

      console.log("User saved successfully");
      return user;
    } catch (error) {
      console.log("Error saving user:", error.message);
      // Handle duplicate key errors (E11000) that might still occur in edge cases
      if (error.code === 11000) {
        // User was created by another request, fetch and return it
        console.log(
          `Duplicate key error detected, fetching existing user: ${email}`,
        );
        const user = await B2CUser.findOne({
          userEmail: email,
          tenantId: tenantId,
        });
        if (user) {
          Object.assign(user, updateData);
          await user.save();
          await syncPortalUserRolesFromMembership(user, email, tenantId, {
            isNewUser: false,
          });
          return user;
        }
      }
      throw error;
    }
  }

  static async handleB2CAuth(code, codeVerifier, policyName) {
    const tokens = await this.exchangeCodeForTokens(
      code,
      codeVerifier,
      policyName,
    );
    const profile = await this.decodeIdToken(tokens.id_token);
    const user = await this.findOrCreateUser(profile, tokens);
    return { user, tokens };
  }
}

module.exports = B2CUsersHandler;
