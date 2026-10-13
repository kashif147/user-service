const axios = require("axios");
const { jwtVerify, createRemoteJWKSet } = require("jose");
const User = require("../models/user.model");
const { buildUserTokensSubdocument } = require("../helpers/oauthTokenStorage");
const Role = require("../models/role.model");
const Tenant = require("../models/tenant.model");
const jwt = require("jsonwebtoken");
const { assignDefaultRole } = require("../helpers/roleAssignment");
const {
  resolveApplicationTenant,
  resolveTenantScopedUser,
  IdentityTenantError,
} = require("../helpers/identityTenantResolution");
const { AppError } = require("../errors/AppError");
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

// Single-tenant, fixed JWKS (never derived from the token being verified). Reused across
// requests: createRemoteJWKSet caches fetched keys and handles kid-based key selection.
let jwksSingleton = null;
function getJwks() {
  if (!jwksSingleton) {
    jwksSingleton = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`),
    );
  }
  return jwksSingleton;
}
/** Exposed for tests only, so a forged-signature test can point verification at a
 * throwaway keypair's JWKS instead of the real Microsoft tenant. */
function _resetJwksForTests(jwks) {
  jwksSingleton = jwks || null;
}

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
      // Only proves the directory is trusted by SOME tenant. The application tenant is decided in
      // findOrCreateUser (login context or the user's own record), never by this lookup.
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
    // Never log `data`: it carries client_secret, the authorization code and the PKCE verifier.
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

  /**
   * @param {string} idToken
   * @param {string} expectedNonce - value this server generated and stored server-side
   *   for the authorize request that produced this token (see helpers/pkceStateStore.js).
   *   Mandatory: without it, a captured/replayed ID token could be reused against a fresh
   *   session, so a missing nonce fails the login rather than proceeding without it.
   */
  /**
   * Verifies a Microsoft ID token for this app (signature via the pinned JWKS, issuer, audience,
   * algorithm, exp/nbf, `tid`, `nonce`) and returns its claims (used by `decodeIdToken`). Does not
   * look up any ProjectShell tenant or user.
   */
  static async verifyIdToken(idToken, expectedNonce) {
    if (!expectedNonce) {
      throw new Error("Azure AD login rejected: missing expected nonce");
    }

    // Signature/issuer/audience/algorithm/exp/nbf verification against Microsoft's real
    // JWKS for the single configured tenant. jwtVerify throws before returning a payload
    // if any of these checks fail, so nothing below this line runs on an
    // unverified/forged/tampered/expired/wrong-issuer/wrong-audience token. Deliberately
    // does not log the token or its decoded payload: both carry PII/identity claims and a
    // captured log line would be as good as a captured token for anyone who can read logs.
    const { payload } = await jwtVerify(idToken, getJwks(), {
      issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      audience: CLIENT_ID,
      algorithms: ["RS256"],
    });

    // Defense in depth: the issuer check above already pins the tenant, but require the
    // claim explicitly rather than relying solely on string-matching the issuer URL, and
    // reject outright if it's absent rather than silently falling back to TENANT_ID.
    if (payload.tid !== TENANT_ID) {
      throw new Error("Azure AD token tenant mismatch");
    }

    if (payload.nonce !== expectedNonce) {
      throw new Error("Azure AD token nonce mismatch");
    }

    return payload;
  }

  static async decodeIdToken(idToken, expectedNonce) {
    const payload = await this.verifyIdToken(idToken, expectedNonce);
    const extractedDirectoryId = payload.tid;

    // Look up Tenant document by directory ID
    const tenant = await findTenantByAzureADDirectoryId(extractedDirectoryId);

    if (!tenant) {
      console.error("Azure AD login: no Tenant found for directory ID", extractedDirectoryId);
      throw new Error(`Tenant not found for Azure AD directory: ${extractedDirectoryId}`);
    }

    const tokenFirstName = payload.given_name || payload.givenName || null;
    const tokenLastName = payload.family_name || payload.surname || null;
    const tokenFullName =
      payload.name ||
      `${tokenFirstName || ""} ${tokenLastName || ""}`.trim() ||
      null;

    const profile = {
      userEmail: payload.email || payload.preferred_username || null,
      userFirstName: tokenFirstName,
      userLastName: tokenLastName,
      userFullName: tokenFullName,
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

    console.log(`Azure AD login verified: tenant=${tenant._id.toString()}`);

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

  /**
   * @param {object} profile  verified token claims (+ Graph profile)
   * @param {object} tokens
   * @param {{tenantId: string, connectionId: string}|null} [loginContext]  the tenant the sign-in
   *   was started for, restored server-side from the OAuth state. When present the user is found or
   *   created ONLY in that tenant; when absent the directory-wide fallback applies.
   */
  static async findOrCreateUser(profile, tokens, loginContext = null) {
    const email = profile.userEmail;
    let tenantId = profile.tenantId;
    try {
      // decodeIdToken validated the trusted Entra directory; the APPLICATION tenant is resolved
      // below from the login context or the ProjectShell user record
      // (helpers/identityTenantResolution.js).
      const resolvedFirstName = profile.userFirstName || null;
      const resolvedLastName = profile.userLastName || null;
      const resolvedFullName =
        profile.userFullName ||
        `${resolvedFirstName || ""} ${resolvedLastName || ""}`.trim() ||
        null;

      if (!email) throw new Error("Email not found in Azure AD token");
      if (!tenantId && !loginContext) {
        console.error("Azure AD login: no tenant could be determined for this sign-in");
        throw new Error("Tenant ID not found in Azure AD token");
      }

      const updateData = {
        ...profile,
        userFirstName: resolvedFirstName,
        userLastName: resolvedLastName,
        userFullName: resolvedFullName,
        userAuthProvider: "azure-ad",
        userType: "CRM",
        userLastLogin: new Date(),
        tenantId: tenantId,
        tokens: buildUserTokensSubdocument(tokens),
        updatedAt: new Date(),
      };

      // Application tenant = the ProjectShell user's own tenant among the tenants that trust this
      // Entra directory (several tenants may share one directory). The directory never assigns or
      // rewrites a user's tenant; first-login provisioning goes to the single auto-provisioning tenant.
      const identity = {
        connectionType: "Entra ID (Azure AD)",
        directoryId: profile.microsoftDirectoryId,
        email,
        microsoftId: profile.userMicrosoftId,
        UserModel: User,
      };
      let resolution;
      try {
        resolution = loginContext
          ? await resolveTenantScopedUser({ ...identity, ...loginContext })
          : await resolveApplicationTenant(identity);
      } catch (err) {
        if (err instanceof IdentityTenantError) {
          console.warn("Azure AD login denied:", {
            reason: err.code,
            mode: loginContext ? "tenant-scoped" : "directory-fallback",
            tenantId: loginContext?.tenantId || null,
          });
          throw AppError.forbidden("CRM sign-in is not available for this account");
        }
        throw err;
      }
      tenantId = resolution.tenantId;
      updateData.tenantId = tenantId;
      let existingUser = resolution.existingUser;

      // Legacy migration only (directory-fallback logins): a user whose tenantId predates Tenant
      // mapping (not a real Tenant, e.g. a raw directory id) is moved into the resolved tenant. A
      // user in another REAL tenant is never moved. Tenant-scoped logins never look outside their
      // tenant.
      if (!existingUser && !loginContext) {
        const legacy = await User.find({
          userEmail: email,
          tenantId: { $nin: resolution.candidateTenantIds },
        }).lean();
        const legacyOnly = [];
        for (const u of legacy) {
          const tid = String(u.tenantId || "");
          const isRealTenant = /^[0-9a-f]{24}$/i.test(tid) && (await Tenant.exists({ _id: tid }));
          if (!isRealTenant) legacyOnly.push(u);
        }
        if (legacyOnly.length === 1) {
          existingUser = legacyOnly[0];
          console.log("📌 Migrating legacy CRM user (pre-tenant-mapping tenantId) into resolved tenant");
        }
      }

      const previousEmail = existingUser?.userEmail;
      const previousFullName = existingUser?.userFullName;
      const isNewUser = !existingUser;
      console.log("CRM sign-in resolved:", {
        mode: loginContext ? "tenant-scoped" : "directory-fallback",
        tenantId,
        outcome: isNewUser ? "provisioned" : "existing",
      });

      // Use atomic findOneAndUpdate with upsert to prevent race conditions
      // If existing user found by email only, update their tenantId to new Tenant._id
      const user = await User.findOneAndUpdate(
        existingUser
          ? { _id: existingUser._id } // the resolved (or legacy-migrated) user, by identity
          : loginContext
            ? { tenantId, userMicrosoftId: profile.userMicrosoftId } // JIT, keyed by the Entra oid
            : { userEmail: email, tenantId: tenantId }, // first-login provisioning
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
        console.log(`Created CRM user ${user._id} in tenant ${tenantId}`);
        if (needsRoleAssignment) {
          await assignDefaultRole(user, "CRM", tenantId);
          // Save again to persist the role assignment
          await user.save();
        }
        await publishCrmUserCreated(user);
      } else {
        console.log(`Updated CRM user ${user._id} in tenant ${tenantId}`);
        // If existing user doesn't have roles, assign them
        if (needsRoleAssignment) {
          await assignDefaultRole(user, "CRM", tenantId);
          await user.save();
        }
        await publishCrmUserUpdated(user, {
          userEmail: previousEmail,
          userFullName: previousFullName,
        });
      }

      return user;
    } catch (error) {
      console.error("Error in findOrCreateUser:", error.message);
      // Handle duplicate key errors (E11000) that might still occur in edge cases
      if (error.code === 11000) {
        // User was created by another request, fetch and return it
        console.log(
          `Duplicate key on CRM user upsert in tenant ${tenantId}; re-reading the existing record`
        );
        const user = await User.findOne(
          loginContext
            ? { tenantId, userMicrosoftId: profile.userMicrosoftId }
            : { userEmail: email, tenantId: tenantId }
        );
        // Only adopt the concurrently-created record of the SAME identity: an email collision with
        // a different oid is a conflict, not a login.
        if (user && (!loginContext || user.userMicrosoftId === profile.userMicrosoftId)) {
          // Update the user with latest data
          Object.assign(user, {
            ...profile,
            userAuthProvider: "azure-ad",
            userType: "CRM",
            userLastLogin: new Date(),
            tenantId: tenantId,
            tokens: buildUserTokensSubdocument(tokens),
          });
          await user.save();
          return user;
        }
      }
      throw error;
    }
  }

  /**
   * @param {string} code
   * @param {string} codeVerifier
   * @param {string|null} redirectUri
   * @param {string} expectedNonce - required; see decodeIdToken's jsdoc.
   * @param {{tenantId: string, connectionId: string}|null} [loginContext] - from the OAuth state.
   */
  static async handleAzureADAuth(code, codeVerifier, redirectUri = null, expectedNonce, loginContext = null) {
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

      console.log("Step 2: Verifying ID token...");
      const baseProfile = await this.decodeIdToken(tokens.id_token, expectedNonce);
      console.log("ID token verified");

      console.log("Step 3: Fetching user info from Graph API...");
      const graphProfile = await this.getUserInfoFromGraph(tokens.access_token);
      console.log("Graph API call completed");

      const combinedProfile = {
        ...baseProfile,
        userFirstName:
          graphProfile.givenName || baseProfile.userFirstName || null,
        userLastName: graphProfile.surname || baseProfile.userLastName || null,
        userFullName:
          graphProfile.displayName ||
          `${graphProfile.givenName || baseProfile.userFirstName || ""} ${
            graphProfile.surname || baseProfile.userLastName || ""
          }`.trim() ||
          baseProfile.userFullName ||
          null,
        userDisplayName: graphProfile.displayName || baseProfile.userFullName,
        userJobTitle: graphProfile.jobTitle || null,
        userDepartment: graphProfile.department || null,
        userOfficeLocation: graphProfile.officeLocation || null,
        userMobilePhone:
          graphProfile.mobilePhone || baseProfile.userMobilePhone,
        userPrincipalName: graphProfile.userPrincipalName || null,
      };

      console.log("Step 4: Finding or creating user...");
      const user = await this.findOrCreateUser(combinedProfile, tokens, loginContext);
      console.log(`CRM sign-in complete: user ${user._id}, tenant ${user.tenantId}`);

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

// Test-only hook: lets a forged-signature test inject a JWKS pointed at a throwaway
// keypair instead of the real Microsoft tenant.
AzureADHandler._resetJwksForTests = _resetJwksForTests;

module.exports = AzureADHandler;
