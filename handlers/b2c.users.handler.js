const axios = require("axios");
const B2CUser = require("../models/user.model");
const Role = require("../models/role.model");
const jwt = require("jsonwebtoken");
const { assignDefaultRole } = require("../helpers/roleAssignment");

const TENANT_ID = process.env.MS_TENANT_NAME || "projectshellAB2C";
const POLICY = process.env.MS_POLICY || "B2C_1_projectshell";
const CLIENT_ID =
  process.env.MS_CLIENT_ID || "e3688a2f-3956-42f9-8c98-6fea7a60a5b4";
const REDIRECT_URI = process.env.MS_REDIRECT_URI || "http://localhost:3000";

const TOKEN_ENDPOINT = `https://${TENANT_ID}.b2clogin.com/${TENANT_ID}.onmicrosoft.com/${POLICY}/oauth2/v2.0/token`;

class B2CUsersHandler {
  static async exchangeCodeForTokens(code, codeVerifier) {
    console.log("=== Token Exchange Debug ===");
    console.log("Token Endpoint:", TOKEN_ENDPOINT);
    console.log("Client ID:", CLIENT_ID);
    console.log("Redirect URI:", REDIRECT_URI);
    console.log("Code (first 50 chars):", code.substring(0, 50) + "...");
    console.log(
      "Code Verifier (first 20 chars):",
      codeVerifier.substring(0, 20) + "..."
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
      const response = await axios.post(TOKEN_ENDPOINT, data.toString(), {
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

  static decodeIdToken(idToken) {
    console.log("Decoding ID token");
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64").toString("utf8")
    );
    console.log("Decoded token payload:", payload);
    console.log("Available tenant ID fields:", {
      tenantId: payload.tenantId,
      extension_tenantId: payload.extension_tenantId,
      tenantId: payload.tenantId,
    });

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
      // Extract tenant ID for proper tenant isolation
      tenantId:
        payload.tenantId ||
        payload.extension_tenantId ||
        payload.tid ||
        "39866a06-30bc-4a89-80c6-9dd9357dd453", // Default tenant
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

    const update = {
      ...profile,
      userAuthProvider: "microsoft",
      userType: "PORTAL", // Ensure portal users are marked as PORTAL type
      userLastLogin: new Date(),
      tenantId: tenantId,
      tokens: {
        id_token: tokens.id_token || null,
        refresh_token: tokens.refresh_token || null,
        id_token_expires_in: tokens.expires_in || null,
        refresh_token_expires_in: tokens.refresh_token_expires_in || null,
      },
    };

    try {
      // Find user by email AND tenantId for strict tenant isolation
      let user = await B2CUser.findOne({
        userEmail: email,
        tenantId: tenantId,
      });

      console.log(user ? "Updating existing user" : "Creating new user");

      if (user) {
        user.set(update);
      } else {
        user = new B2CUser(update);

        // Assign default role to new portal users with tenantId
        await assignDefaultRole(user, "PORTAL", tenantId);
      }

      await user.save();
      console.log("User saved successfully");
      return user;
    } catch (error) {
      console.log("Error saving user:", error.message);
      throw error;
    }
  }

  static async handleB2CAuth(code, codeVerifier) {
    const tokens = await this.exchangeCodeForTokens(code, codeVerifier);
    const profile = this.decodeIdToken(tokens.id_token);
    const user = await this.findOrCreateUser(profile, tokens);
    return { user, tokens };
  }
}

module.exports = B2CUsersHandler;
