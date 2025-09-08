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
    const email = profile.userEmail;
    const tenantId = profile.tenantId;
    
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

    // Find user by email AND tenantId for strict tenant isolation
    let user = await User.findOne({ userEmail: email, tenantId: tenantId });
    if (user) {
      user.set(update);
    } else {
      user = new User(update);

      // Assign default role to new CRM users with tenantId
      await assignDefaultRole(user, "CRM", tenantId);
    }

    await user.save();
    return user;
  }

  static async handleAzureADAuth(code, codeVerifier) {
    const tokens = await this.exchangeCodeForTokens(code, codeVerifier);
    const baseProfile = this.decodeIdToken(tokens.id_token);
    const graphProfile = await this.getUserInfoFromGraph(tokens.access_token);

    const combinedProfile = {
      ...baseProfile,
      userDisplayName: graphProfile.displayName || baseProfile.userFullName,
      userJobTitle: graphProfile.jobTitle || null,
      userDepartment: graphProfile.department || null,
      userOfficeLocation: graphProfile.officeLocation || null,
      userMobilePhone: graphProfile.mobilePhone || baseProfile.userMobilePhone,
      userPrincipalName: graphProfile.userPrincipalName || null,
    };

    const user = await this.findOrCreateUser(combinedProfile, tokens);
    return { user, tokens };
  }
}

module.exports = AzureADHandler;
