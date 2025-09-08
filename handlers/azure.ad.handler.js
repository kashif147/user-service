const axios = require("axios");
const User = require("../models/user");
const Role = require("../models/role");
const jwt = require("jsonwebtoken");
const { assignDefaultRole } = require("../helpers/roleAssignment");

const TENANT_ID = process.env.AZURE_AD_TENANT_ID;
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_AD_CLIENT_SECRET;
const REDIRECT_URI = process.env.AZURE_AD_REDIRECT_URI;

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
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64").toString("utf8")
    );

    return {
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
      // Extract tenant ID for proper tenant isolation
      tenantId: payload.tid || null,
    };
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
      console.log("=== findOrCreateUser: Starting ===");
      const email = profile.userEmail;
      const tenantId = profile.tenantId;

      console.log("Email:", email);
      console.log("TenantId:", tenantId);

      if (!email) throw new Error("Email not found in Azure AD token");
      if (!tenantId) throw new Error("Tenant ID not found in Azure AD token");

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

      console.log("Searching for existing user...");
      // Find user by email AND tenantId for strict tenant isolation
      let user = await User.findOne({ userEmail: email, tenantId: tenantId });

      if (user) {
        console.log("Found existing user, updating...");
        user.set(update);
      } else {
        console.log("Creating new user...");
        user = new User(update);

        console.log("Skipping role assignment for debugging...");
        // Temporarily bypass role assignment to test token generation
        // await assignDefaultRole(user, "CRM", tenantId);
      }

      console.log("Saving user to database...");
      await user.save();
      console.log("User saved successfully, ID:", user._id);

      return user;
    } catch (error) {
      console.error("=== findOrCreateUser Error ===");
      console.error("Error in findOrCreateUser:", error.message);
      console.error("Error stack:", error.stack);
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
      const baseProfile = this.decodeIdToken(tokens.id_token);
      console.log("ID token decoded, email:", baseProfile.userEmail);

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
