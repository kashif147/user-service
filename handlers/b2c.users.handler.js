const axios = require("axios");
const { jwtVerify, createRemoteJWKSet } = require("jose");
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
const {
  b2cTokenEndpoint,
  b2cJwksUrl,
  b2cExpectedIssuer,
  getAllowedPolicies,
} = require("../helpers/b2cPolicy");

// One remote JWKS set per B2C policy (Azure AD B2C publishes signing keys per policy),
// reused across requests: createRemoteJWKSet caches fetched keys and handles kid-based
// key selection internally.
const jwksByPolicy = new Map();
function getJwksForPolicy(policyName) {
  if (!jwksByPolicy.has(policyName)) {
    jwksByPolicy.set(
      policyName,
      createRemoteJWKSet(new URL(b2cJwksUrl(policyName))),
    );
  }
  return jwksByPolicy.get(policyName);
}
/** Exposed for tests only, so a forged-signature test can inject a JWKS pointed at a
 * throwaway keypair instead of a real Microsoft tenant. */
function _resetJwksForTests(policyName, jwks) {
  if (jwks) {
    jwksByPolicy.set(policyName, jwks);
  } else {
    jwksByPolicy.delete(policyName);
  }
}

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

  /**
   * @param {string} idToken
   * @param {string} policyName - the B2C policy this server used for the authorize/token
   *   exchange that produced this token (server-side, trusted for this login transaction -
   *   see helpers/pkceStateStore.js's state->policy mapping). Signing keys and the JWKS
   *   discovery URL are policy-specific in Azure AD B2C, and the token's own policy claim
   *   must match it exactly - not just be "some" allowed policy - or a token issued for a
   *   different flow (e.g. password-reset) could be replayed as a sign-in token.
   * @param {string} expectedNonce - value this server generated and stored server-side
   *   for the authorize request that produced this token. Mandatory: without it, a
   *   captured/replayed ID token could be reused against a fresh session.
   */
  static async decodeIdToken(idToken, policyName, expectedNonce) {
    if (!expectedNonce) {
      throw new Error("B2C login rejected: missing expected nonce");
    }

    // policyName reaches this function from server-side state (pkceStateStore), not
    // directly from the request body - but validate it against the allow-list anyway
    // before using it to pick a JWKS URL, as defense in depth against any future caller
    // that passes it through less carefully.
    if (!getAllowedPolicies().has(policyName)) {
      throw new Error("B2C policy not allowed");
    }

    if (!process.env.MS_B2C_DIRECTORY_ID) {
      // b2cExpectedIssuer() below already throws on this, but fail here too with an
      // unambiguous message before any network/JWKS work happens.
      throw new Error("MS_B2C_DIRECTORY_ID is not configured");
    }

    // Signature/issuer/audience/algorithm/exp/nbf verification against Microsoft's real
    // JWKS for the single configured B2C tenant/policy. jwtVerify throws before returning
    // a payload if any of these checks fail, so nothing below this line runs on an
    // unverified/forged/tampered/expired/wrong-issuer/wrong-audience token. Deliberately
    // does not log the token or its decoded payload: both carry PII/identity claims and a
    // captured log line would be as good as a captured token for anyone who can read logs.
    const { payload } = await jwtVerify(idToken, getJwksForPolicy(policyName), {
      issuer: b2cExpectedIssuer(),
      audience: CLIENT_ID,
      algorithms: ["RS256"],
    });

    // B2C tokens carry the policy as `tfp`; some configurations/token versions surface it
    // as `acr` instead. Require an exact match against the specific policy this
    // transaction used - not merely "is in the allowed set" - so a token issued under a
    // different flow can't be substituted.
    const verifiedPolicy = payload.tfp || payload.acr;
    if (verifiedPolicy !== policyName) {
      throw new Error("B2C token policy does not match the login transaction");
    }

    if (payload.nonce !== expectedNonce) {
      throw new Error("B2C token nonce mismatch");
    }

    // The issuer check above already pins this to the single configured B2C directory, so
    // use that fixed, trusted value for the tenant lookup below rather than deriving a
    // directory ID from token claims (tid/extension_tenantId/tenantId/iss) - single-tenant
    // by design, no per-customer B2C directory discovery here.
    const extractedDirectoryId = process.env.MS_B2C_DIRECTORY_ID;

    // Look up Tenant document by directory ID
    const tenant = await findTenantByB2CDirectoryId(extractedDirectoryId);

    if (!tenant) {
      console.error("B2C login: no Tenant found for directory ID", extractedDirectoryId);
      throw new Error(
        `Tenant not found for Azure B2C directory: ${extractedDirectoryId}`,
      );
    }

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

  /**
   * @param {string} code
   * @param {string} codeVerifier
   * @param {string} policyName
   * @param {string} expectedNonce - required; see decodeIdToken's jsdoc.
   */
  static async handleB2CAuth(code, codeVerifier, policyName, expectedNonce) {
    const tokens = await this.exchangeCodeForTokens(
      code,
      codeVerifier,
      policyName,
    );
    const profile = await this.decodeIdToken(tokens.id_token, policyName, expectedNonce);
    const user = await this.findOrCreateUser(profile, tokens);
    return { user, tokens };
  }
}

// Test-only hook: lets a forged-signature test inject a JWKS pointed at a throwaway
// keypair instead of the real Microsoft tenant, per policy.
B2CUsersHandler._resetJwksForTests = _resetJwksForTests;

module.exports = B2CUsersHandler;
