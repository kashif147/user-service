const axios = require("axios");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const Tenant = require("../models/tenant.model");
const jwt = require("jsonwebtoken");
const { assignDefaultRole } = require("../helpers/roleAssignment");
const {
  publishCrmUserCreated,
  publishCrmUserUpdated,
} = require("../rabbitMQ/publishers/user.crm.publisher");

const TENANT_ID =
  process.env.AZURE_AD_TENANT_ID || "39866a06-30bc-4a89-80c6-9dd9357dd453";
const CLIENT_ID =
  process.env.AZURE_AD_CLIENT_ID || "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae";
const CLIENT_SECRET = process.env.AZURE_AD_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.AZURE_AD_REDIRECT_URI || "http://localhost:3000/auth/azure-crm";

const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const GRAPH_ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me";

/**
 * Find Tenant document by Azure AD directory ID
 * @param {string} directoryId - Microsoft directory ID (tid from token)
 * @returns {Promise<Object|null>} Tenant document or null
 */
async function findTenantByAzureADDirectoryId(directoryId) {
  try {
    console.log("=== Looking up Tenant by Azure AD directory ID ===");
    console.log("Directory ID from Microsoft:", directoryId);
    
    const tenant = await Tenant.findOne({
      "authenticationConnections.connectionType": "Entra ID (Azure AD)",
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
      console.log("❌ No Tenant found for Azure AD directory ID:", directoryId);
      console.log("💡 Make sure Tenant document has:");
      console.log("   - authenticationConnections.connectionType = 'Entra ID (Azure AD)'");
      console.log("   - authenticationConnections.directoryId =", directoryId);
      return null;
    }
  } catch (error) {
    console.error("Error looking up Tenant:", error.message);
    return null;
  }
}

class AzureADHandler {
  static async exchangeCodeForTokens(code, codeVerifier, redirectUri = null) {
    // Clean code if it contains URL fragments or query parameters
    const originalCodeLength = code.length;
    const cleanCode = code.replace(/[&#].*$/, "");
    if (cleanCode.length !== originalCodeLength) {
      console.warn(
        `Code was cleaned: original length ${originalCodeLength}, cleaned length ${cleanCode.length}`
      );
    }

    console.log("Code length:", cleanCode.length);
    console.log("CodeVerifier length:", codeVerifier?.length || 0);

    // Use provided redirect_uri or fall back to environment variable/default
    const finalRedirectUri = redirectUri || REDIRECT_URI;
    console.log("Using redirect_uri:", finalRedirectUri);

    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: finalRedirectUri,
      code: cleanCode,
      code_verifier: codeVerifier,
      scope: "openid profile email offline_access",
    });

    console.log("== Azure AD Token Exchange Request ==");
    console.log("POST:", TOKEN_ENDPOINT);
    console.log("Data:", data.toString());
    console.log("Headers:", {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    console.log("=======================================");

    try {
      const response = await axios.post(TOKEN_ENDPOINT, data.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      return response.data;
    } catch (error) {
      console.error("=== Token Exchange Failed ===");
      console.error("Error message:", error.message);
      console.error("Error code:", error.code);

      if (error.response) {
        console.error("Azure AD Error Status:", error.response.status);
        console.error(
          "Azure AD Error Data:",
          JSON.stringify(error.response.data, null, 2)
        );

        const azureError = error.response.data;
        if (azureError.error) {
          const errorMsg = azureError.error_description || azureError.error;
          const enhancedError = new Error(
            `Azure AD token exchange failed: ${errorMsg}`
          );
          enhancedError.azureError = azureError;
          enhancedError.statusCode = error.response.status;
          throw enhancedError;
        }
      } else if (error.request) {
        console.error("No response received from Azure AD");
        console.error("Request config:", {
          url: error.config?.url,
          method: error.config?.method,
        });
        throw new Error(
          "Failed to connect to Azure AD. Please check network connectivity."
        );
      } else {
        console.error("Error setting up request:", error.message);
      }

      throw error;
    }
  }

  static async decodeIdToken(idToken) {
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║   🔍 WHAT MICROSOFT SENDS WHEN USER LOGS IN (AZURE AD)        ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log("\n");
    console.log("=== Azure AD decodeIdToken Debug ===");
    console.log(
      "ID Token (first 100 chars):",
      idToken.substring(0, 100) + "..."
    );

    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64").toString("utf8")
    );

    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║   📋 FULL AZURE AD TOKEN PAYLOAD FROM MICROSOFT               ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log(JSON.stringify(payload, null, 2));
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║   🔑 KEY FIELDS FROM MICROSOFT                                ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log({
      "Directory ID (tid)": payload.tid,
      "Tenant ID": payload.tenantId,
      "User ID (oid)": payload.oid,
      "Email": payload.email || payload.preferred_username,
      "Name": payload.name || payload.given_name,
      "Issuer": payload.iss,
      "Audience": payload.aud,
    });
    console.log("\n=== ALL PAYLOAD KEYS ===");
    console.log(Object.keys(payload));

    const extractedDirectoryId =
      payload.tid || payload.tenantId || payload.tenant_id || TENANT_ID;
    console.log("Extracted Microsoft directory ID:", extractedDirectoryId);
    console.log("Using fallback directory ID:", TENANT_ID);

    // Look up Tenant document by directory ID
    const tenant = await findTenantByAzureADDirectoryId(extractedDirectoryId);
    
    if (!tenant) {
      console.error("❌ ERROR: No Tenant found for directory ID:", extractedDirectoryId);
      console.error("Please ensure Tenant document exists with matching authenticationConnections");
      throw new Error(`Tenant not found for Azure AD directory: ${extractedDirectoryId}`);
    }

    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║   ✅ TENANT MAPPING RESULT (CRM)                               ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log("Microsoft Directory ID:", extractedDirectoryId);
    console.log("Tenant Document _id:", tenant._id.toString());
    console.log("📌 Using Tenant._id as tenantId in user document and JWT token");
    console.log("");

    const profile = {
      userEmail: payload.email || payload.preferred_username || null,
      userFirstName: payload.given_name || null,
      userLastName: payload.family_name || null,
      userFullName: `${payload.given_name || ""} ${
        payload.family_name || ""
      }`.trim(),
      userMobilePhone: payload.phone_number || null,
      userMemberNumber: null,
      userMicrosoftId: payload.oid || payload.sub || null,
      userSubject: payload.sub || null,
      userAudience: payload.aud || null,
      userIssuer: payload.iss || null,
      userIssuedAt: payload.iat || null,
      userAuthTime: payload.auth_time || null,
      userTokenVersion: payload.ver || "2.0",
      userPolicy: null,
      // Use Tenant._id instead of Microsoft directory ID
      tenantId: tenant._id.toString(),
      // Store Microsoft directory ID separately for reference
      microsoftDirectoryId: extractedDirectoryId,
    };

    console.log("Final profile with Tenant._id:", JSON.stringify(profile, null, 2));
    console.log("=== End Azure AD decodeIdToken Debug ===");

    return profile;
  }

  static async getUserInfoFromGraph(accessToken) {
    try {
      const response = await axios.get(GRAPH_ME_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.data;
    } catch (error) {
      console.error(
        "Failed to fetch user info from Microsoft Graph:",
        error.message
      );
      return {};
    }
  }

  static async findOrCreateUser(profile, tokens) {
    try {
      console.log("=== Azure AD findOrCreateUser Debug ===");
      console.log("Profile received:", JSON.stringify(profile, null, 2));

      const email = profile.userEmail;
      const tenantId = profile.tenantId;

      console.log("Extracted email:", email);
      console.log("Extracted tenantId:", tenantId);

      if (!email) throw new Error("Email not found in Azure AD token");
      if (!tenantId) {
        console.error("ERROR: Tenant ID is missing from profile!");
        console.error("Profile keys:", Object.keys(profile));
        console.error("Profile tenantId field:", profile.tenantId);
        console.error("Fallback tenant ID:", TENANT_ID);
        throw new Error("Tenant ID not found in Azure AD token");
      }

      const updateData = {
        ...profile,
        userAuthProvider: "azure-ad",
        userType: "CRM",
        userLastLogin: new Date(),
        tenantId: tenantId,
        tokens: {
          id_token: tokens.id_token || null,
          refresh_token: tokens.refresh_token || null,
          id_token_expires_in: tokens.expires_in || null,
          refresh_token_expires_in: tokens.refresh_token_expires_in || null,
        },
        updatedAt: new Date(),
      };

      // First, try to find existing user by email + new tenantId (Tenant._id)
      let existingUser = await User.findOne({
        userEmail: email,
        tenantId: tenantId,
      }).lean();

      // If not found, try to find by email only (for existing users created before tenant mapping)
      // This handles migration of existing users to new tenant mapping
      if (!existingUser) {
        console.log("⚠️  User not found with new tenantId, checking for existing user by email only...");
        existingUser = await User.findOne({
          userEmail: email,
        }).lean();
        
        if (existingUser) {
          console.log("✅ Found existing user with old tenantId:", existingUser.tenantId);
          console.log("📌 Will update tenantId from", existingUser.tenantId, "to", tenantId);
        }
      }

      const previousEmail = existingUser?.userEmail;
      const previousFullName = existingUser?.userFullName;
      const isNewUser = !existingUser;

      // Use atomic findOneAndUpdate with upsert to prevent race conditions
      // If existing user found by email only, update their tenantId to new Tenant._id
      const user = await User.findOneAndUpdate(
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
        }
      );

      // Check if user needs role assignment (new user or existing user without roles)
      const needsRoleAssignment =
        isNewUser || !user.roles || user.roles.length === 0;

      if (isNewUser) {
        console.log(`Creating new CRM user: ${email}`);
        if (needsRoleAssignment) {
          await assignDefaultRole(user, "CRM", tenantId);
          // Save again to persist the role assignment
          await user.save();
        }
        await publishCrmUserCreated(user);
      } else {
        console.log(`Updating existing CRM user: ${email}`);
        // If existing user doesn't have roles, assign them
        if (needsRoleAssignment) {
          await assignDefaultRole(user, "CRM", tenantId);
          await user.save();
        }
        await publishCrmUserUpdated(user, {
          userEmail: previousEmail,
          userFullName: previousFullName,
        }, true); // forcePublish = true to ensure user is synced to subscription-service on every login
      }

      console.log(`User processed successfully: ${email}`);
      return user;
    } catch (error) {
      console.error("Error in findOrCreateUser:", error.message);
      // Handle duplicate key errors (E11000) that might still occur in edge cases
      if (error.code === 11000) {
        // User was created by another request, fetch and return it
        console.log(
          `Duplicate key error detected, fetching existing user: ${email}`
        );
        const user = await User.findOne({
          userEmail: email,
          tenantId: tenantId,
        });
        if (user) {
          // Update the user with latest data
          Object.assign(user, {
            ...profile,
            userAuthProvider: "azure-ad",
            userType: "CRM",
            userLastLogin: new Date(),
            tenantId: tenantId,
            tokens: {
              id_token: tokens.id_token || null,
              refresh_token: tokens.refresh_token || null,
              id_token_expires_in: tokens.expires_in || null,
              refresh_token_expires_in: tokens.refresh_token_expires_in || null,
            },
          });
          await user.save();
          return user;
        }
      }
      throw error;
    }
  }

  static async handleAzureADAuth(code, codeVerifier, redirectUri = null) {
    try {
      console.log("=== Azure AD Handler: Starting Authentication ===");
      console.log("Code present:", !!code);
      console.log("CodeVerifier present:", !!codeVerifier);
      console.log("Redirect URI provided:", redirectUri || "using default");

      console.log("Step 1: Exchanging code for tokens...");
      const tokens = await this.exchangeCodeForTokens(
        code,
        codeVerifier,
        redirectUri
      );
      console.log("Token exchange successful");

      console.log("Step 2: Decoding ID token...");
      console.log("ID token present:", !!tokens.id_token);
      console.log(
        "ID token (first 100 chars):",
        tokens.id_token ? tokens.id_token.substring(0, 100) + "..." : "MISSING"
      );
    const baseProfile = await this.decodeIdToken(tokens.id_token);
      console.log("ID token decoded, email:", baseProfile.userEmail);
      console.log("ID token decoded, tenantId:", baseProfile.tenantId);

      console.log("Step 3: Fetching user info from Graph API...");
      const graphProfile = await this.getUserInfoFromGraph(tokens.access_token);
      console.log("Graph API call completed");

      const combinedProfile = {
        ...baseProfile,
        userDisplayName: graphProfile.displayName || baseProfile.userFullName,
        userJobTitle: graphProfile.jobTitle || null,
        userDepartment: graphProfile.department || null,
        userOfficeLocation: graphProfile.officeLocation || null,
        userMobilePhone:
          graphProfile.mobilePhone || baseProfile.userMobilePhone,
        userPrincipalName: graphProfile.userPrincipalName || null,
      };

      console.log("Step 4: Finding or creating user...");
      console.log("Combined profile keys:", Object.keys(combinedProfile));
      console.log("Combined profile tenantId:", combinedProfile.tenantId);
      const user = await this.findOrCreateUser(combinedProfile, tokens);
      console.log("User processed successfully, ID:", user._id);

      console.log("=== Azure AD Handler: Authentication Completed ===");
      return { user, tokens };
    } catch (error) {
      console.error("=== Azure AD Handler Error ===");
      console.error("Error in handleAzureADAuth:", error.message);
      console.error("Error stack:", error.stack);
      if (error.azureError) {
        console.error(
          "Azure AD specific error:",
          JSON.stringify(error.azureError, null, 2)
        );
      }
      if (error.statusCode) {
        console.error("HTTP Status Code:", error.statusCode);
      }
      throw error;
    }
  }
}

module.exports = AzureADHandler;
