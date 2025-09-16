const axios = require("axios");
const User = require("../models/user");
const Role = require("../models/role");
const jwt = require("jsonwebtoken");
const { assignDefaultRole } = require("../helpers/roleAssignment");

const TENANT_ID =
  process.env.AZURE_AD_TENANT_ID || "39866a06-30bc-4a89-80c6-9dd9357dd453";
const CLIENT_ID =
  process.env.AZURE_AD_CLIENT_ID || "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae";
const CLIENT_SECRET = process.env.AZURE_AD_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.AZURE_AD_REDIRECT_URI || "http://localhost:3000/auth/azure-crm";

const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const GRAPH_ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me";

class AzureADHandler {
  static async exchangeCodeForTokens(code, codeVerifier) {
    const cleanCode = code.replace(/[&#].*$/, "");

    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
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
      console.error("Token exchange failed:", error.message);

      if (error.response) {
        console.error("Azure AD Error Status:", error.response.status);
        console.error(
          "Azure AD Error Data:",
          JSON.stringify(error.response.data, null, 2)
        );
      } else {
        console.error("No response from Azure:", error);
      }

      throw error;
    }
  }

  static decodeIdToken(idToken) {
    console.log("=== Azure AD decodeIdToken Debug ===");
    console.log(
      "ID Token (first 100 chars):",
      idToken.substring(0, 100) + "..."
    );

    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64").toString("utf8")
    );

    console.log("Azure AD token payload:", JSON.stringify(payload, null, 2));
    console.log("Available tenant ID fields:", {
      tid: payload.tid,
      tenantId: payload.tenantId,
      tenant_id: payload.tenant_id,
    });

    const extractedTenantId =
      payload.tid || payload.tenantId || payload.tenant_id || TENANT_ID;
    console.log("Extracted tenant ID:", extractedTenantId);
    console.log("Using fallback tenant ID:", TENANT_ID);

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
      // Extract tenant ID for proper tenant isolation - Azure AD uses 'tid' claim
      tenantId: extractedTenantId,
    };

    console.log("Final profile:", JSON.stringify(profile, null, 2));
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

      const update = {
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
      };

      // Find user by email AND tenantId for strict tenant isolation
      let user = await User.findOne({ userEmail: email, tenantId: tenantId });

      if (user) {
        console.log(`Updating existing CRM user: ${email}`);
        user.set(update);
      } else {
        console.log(`Creating new CRM user: ${email}`);
        user = new User(update);

        // Assign default role to new CRM users with tenantId
        await assignDefaultRole(user, "CRM", tenantId);
      }

      await user.save();
      console.log(`User processed successfully: ${email}`);

      return user;
    } catch (error) {
      console.error("Error in findOrCreateUser:", error.message);
      throw error;
    }
  }

  static async handleAzureADAuth(code, codeVerifier) {
    try {
      console.log("=== Azure AD Handler: Starting Authentication ===");
      console.log("Code present:", !!code);
      console.log("CodeVerifier present:", !!codeVerifier);

      console.log("Step 1: Exchanging code for tokens...");
      const tokens = await this.exchangeCodeForTokens(code, codeVerifier);
      console.log("Token exchange successful");

      console.log("Step 2: Decoding ID token...");
      console.log("ID token present:", !!tokens.id_token);
      console.log(
        "ID token (first 100 chars):",
        tokens.id_token ? tokens.id_token.substring(0, 100) + "..." : "MISSING"
      );
      const baseProfile = this.decodeIdToken(tokens.id_token);
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
      throw error;
    }
  }
}

module.exports = AzureADHandler;
