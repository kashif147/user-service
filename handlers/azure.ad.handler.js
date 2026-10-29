const axios = require("axios");
const { jwtVerify, createRemoteJWKSet } = require("jose");
const User = require("../models/user.model");
const { buildUserTokensSubdocument } = require("../helpers/oauthTokenStorage");
const jwt = require("jsonwebtoken");
const {
  isAutomatic,
  resolveJitDefaultRoleId,
  hasActiveRoleInTenant,
  DefaultRoleError,
} = require("../helpers/connectionDefaultRole");
const {
  resolveApplicationTenant,
  resolveTenantScopedUser,
  IdentityTenantError,
  isPlaceholderMicrosoftId,
} = require("../helpers/identityTenantResolution");
const { AppError } = require("../errors/AppError");
const {
  publishCrmUserCreated,
  publishCrmUserUpdated,
} = require("../rabbitMQ/publishers/user.crm.publisher");

const {
  resolveConnectionAuthConfig,
  isOrganisationConfigError,
} = require("../helpers/connectionAuthConfig");
const { loadLoginConnection, LoginTenantError, ENTRA } = require("../helpers/loginTenantContext");
const { assertConnectionDirectoryClaim } = require("../helpers/directoryClaimGate");
const { microsoftErrorFields, isMicrosoftTokenError } = require("../helpers/microsoftErrorLog");

// Public message for a CRM user without any active role in the organisation.
const NO_ORGANISATION_ACCESS = "You don't have access to this organisation";

// An existing CRM user may sign in only while active and holding at least one active role of the
// organisation. Checked before the user record is updated and before any token is issued.
async function assertCrmSignInAllowed(user, tenantId) {
  if (user.isActive === false) {
    console.warn("Azure AD login denied:", { reason: "INACTIVE_USER", userId: String(user._id), tenantId });
    throw AppError.forbidden("CRM sign-in is not available for this account");
  }
  if (!(await hasActiveRoleInTenant(user, tenantId))) {
    console.warn("Azure AD login denied:", { reason: "NO_ACTIVE_ROLE", userId: String(user._id), tenantId });
    throw AppError.forbidden(NO_ORGANISATION_ACCESS);
  }
}

// CRM sign-in operates only on CRM users, and a stored (non-placeholder) Microsoft id is never
// re-bound: an email match carrying a different oid, or a non-CRM record, is refused with the
// standard denial before any write. Checked on both CRM paths, with and without an organisation code.
function assertCrmIdentityBinding(user, incomingMicrosoftId, tenantId) {
  let reason = null;
  if (user.userType !== "CRM") reason = "USER_TYPE_MISMATCH";
  else if (!isPlaceholderMicrosoftId(user.userMicrosoftId) && user.userMicrosoftId !== incomingMicrosoftId) {
    reason = "MICROSOFT_ID_MISMATCH";
  }
  if (reason) {
    console.warn("Azure AD login denied:", { reason, userId: String(user._id), tenantId });
    throw AppError.forbidden("CRM sign-in is not available for this account");
  }
}

// Atomic counterpart of assertCrmIdentityBinding for the update filter: the write applies only while
// the record is still a CRM user whose stored Microsoft id is the one approved above (still unbound,
// or the same oid), so a concurrent link or re-bind after the check cannot be overwritten.
function crmIdentityUnchanged(user) {
  const stored = user.userMicrosoftId;
  return {
    userType: "CRM",
    userMicrosoftId: isPlaceholderMicrosoftId(stored) ? { $in: [null, "", ...(stored ? [stored] : [])] } : stored,
  };
}

const GRAPH_ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me";

// Remote JWKS sets keyed by JWKS URI, i.e. by directory (never derived from the token being
// verified: the URI comes from the selected connection's resolved configuration). Keys fetched
// for one directory are never used to verify a token for another. Reused across requests:
// createRemoteJWKSet caches fetched keys and handles kid-based key selection.
const jwksByUri = new Map();
function getJwks(jwksUri) {
  if (!jwksByUri.has(jwksUri)) {
    jwksByUri.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)));
  }
  return jwksByUri.get(jwksUri);
}
/** Exposed for tests only, so a forged-signature test can point verification at a throwaway
 * keypair's JWKS instead of the real Microsoft tenant. `jwksUri` defaults to the CRM app's home
 * directory; `jwks` null removes that entry (or every entry when no URI is given). */
function _resetJwksForTests(jwks, jwksUri) {
  if (!jwks && !jwksUri) {
    jwksByUri.clear();
    return;
  }
  const uri = jwksUri || resolveConnectionAuthConfig(null, { connectionType: ENTRA }).jwksUri;
  if (jwks) jwksByUri.set(uri, jwks);
  else jwksByUri.delete(uri);
}

// Every refusal of a CRM sign-in has the same public message; the reason is logged server-side.
const CRM_SIGN_IN_DENIED = "CRM sign-in is not available for this account";

class AzureADHandler {
  /**
   * @param {string} code
   * @param {string} codeVerifier
   * @param {object} authConfig  resolved connection configuration (helpers/connectionAuthConfig.js):
   *   token endpoint, client id, client secret and redirect URI all come from it - never from the
   *   request or a separate environment read.
   */
  static async exchangeCodeForTokens(code, codeVerifier, authConfig) {
    if (!authConfig || !authConfig.tokenEndpoint) {
      throw new Error("Azure AD token exchange requires the resolved connection configuration");
    }
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

    const tokenEndpoint = authConfig.tokenEndpoint;

    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: authConfig.clientId,
      client_secret: authConfig.clientSecret,
      // Always the trusted, registered redirect URI of the app registration (the one the authorize
      // request used); a redirect URI from the request is never accepted.
      redirect_uri: authConfig.redirectUri,
      code: cleanCode,
      code_verifier: codeVerifier,
      scope: authConfig.scopes,
    });

    console.log("== Azure AD Token Exchange Request ==");
    console.log("POST:", tokenEndpoint);
    // Never log `data`: it carries client_secret, the authorization code and the PKCE verifier.
    console.log("Headers:", {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    console.log("=======================================");

    try {
      const response = await axios.post(tokenEndpoint, data.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      return response.data;
    } catch (error) {
      console.error("=== Token Exchange Failed ===");
      console.error("Error message:", error.message);
      console.error("Error code:", error.code);

      if (error.response) {
        console.error(
          "Azure AD token exchange error:",
          microsoftErrorFields(error.response.status, error.response.data),
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
   * Verifies a Microsoft ID token against the SELECTED connection's resolved configuration
   * (signature via that directory's JWKS, issuer derived from its directory, audience = the app
   * registration's client id, algorithm, exp/nbf, `tid` = the connection's directory, `nonce`)
   * and returns its claims (used by `decodeIdToken`). A token for another directory fails even if
   * otherwise valid. Does not look up any ProjectShell tenant or user.
   */
  static async verifyIdToken(idToken, expectedNonce, authConfig) {
    if (!expectedNonce) {
      throw new Error("Azure AD login rejected: missing expected nonce");
    }
    if (!authConfig || !authConfig.jwksUri || !authConfig.directoryId) {
      throw new Error("Azure AD login rejected: no resolved connection configuration");
    }

    // Signature/issuer/audience/algorithm/exp/nbf verification against Microsoft's real
    // JWKS for the connection's directory. jwtVerify throws before returning a payload
    // if any of these checks fail, so nothing below this line runs on an
    // unverified/forged/tampered/expired/wrong-issuer/wrong-audience token. Deliberately
    // does not log the token or its decoded payload: both carry PII/identity claims and a
    // captured log line would be as good as a captured token for anyone who can read logs.
    const { payload } = await jwtVerify(idToken, getJwks(authConfig.jwksUri), {
      issuer: authConfig.issuer,
      audience: authConfig.audience,
      algorithms: ["RS256"],
    });

    // Defense in depth: the issuer check above already pins the tenant, but require the
    // claim explicitly rather than relying solely on string-matching the issuer URL, and
    // reject outright if it's absent rather than silently falling back to the configured id.
    if (payload.tid !== authConfig.directoryId) {
      throw new Error("Azure AD token tenant mismatch");
    }

    if (payload.nonce !== expectedNonce) {
      throw new Error("Azure AD token nonce mismatch");
    }

    return payload;
  }

  static async decodeIdToken(idToken, expectedNonce, authConfig) {
    const payload = await this.verifyIdToken(idToken, expectedNonce, authConfig);
    // The verified directory only says WHO issued the token. It never selects a ProjectShell
    // tenant (several tenants may share one directory): findOrCreateUser resolves the tenant from
    // the login context or the user's own record (helpers/identityTenantResolution.js).
    const extractedDirectoryId = payload.tid;

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
      // Microsoft directory id, kept for reference; not a ProjectShell tenant
      microsoftDirectoryId: extractedDirectoryId,
    };

    // Phase B / Z1: the verified identity for the platform-claim decision (services/platformClaimService.js).
    // Strictly oid (no sub fallback). Non-enumerable, so spreading the profile into the user record
    // never copies it.
    Object.defineProperty(profile, "verifiedIdentity", {
      value: Object.freeze({
        issuer: payload.iss || null,
        oid: payload.oid || null,
        tid: payload.tid || null,
        amr: Array.isArray(payload.amr) ? [...payload.amr] : null,
      }),
      enumerable: false,
    });

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
   * @param {object} tokens  Microsoft token response - NOT persisted for CRM users (nulls are stored)
   * @param {{tenantId: string, connectionId: string}|null} [loginContext]  the tenant the sign-in
   *   was started for, restored server-side from the OAuth state. When present the user is found or
   *   created ONLY in that tenant; when absent the directory-wide fallback applies.
   */
  static async findOrCreateUser(profile, tokens, loginContext = null) {
    const email = profile.userEmail;
    // Set only by the tenant resolution below; any tenantId on the profile is ignored.
    let tenantId = null;
    let identityProfile = {}; // the profile without any tenant field (also used by the E11000 retry)
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

      identityProfile = { ...profile };
      delete identityProfile.tenantId;
      const updateData = {
        ...identityProfile,
        userFirstName: resolvedFirstName,
        userLastName: resolvedLastName,
        userFullName: resolvedFullName,
        userAuthProvider: "azure-ad",
        userType: "CRM",
        userLastLogin: new Date(),
        // CRM users keep NO Microsoft OAuth credentials: the ID / access tokens are used only within
        // this request, and any token material stored by an earlier login is cleared (nulls). The
        // Entra identity linkage (userMicrosoftId, issuer) is kept.
        tokens: buildUserTokensSubdocument(null),
        updatedAt: new Date(),
      };

      // Application tenant = the organisation the login was started for (tenant-scoped), or, on the
      // legacy no-code path, the existing user's own tenant among the tenants that trust this Entra
      // directory. The directory never assigns or rewrites a user's tenant; first-login provisioning
      // happens only on a tenant-scoped login through an automatic connection.
      const identity = {
        connectionType: "Entra ID (Azure AD)",
        directoryId: profile.microsoftDirectoryId,
        email,
        microsoftId: profile.userMicrosoftId,
        UserModel: User,
      };
      let resolution;
      try {
        // Without an organisation code (legacy path) only EXISTING users may sign in: a new user
        // is never provisioned into an organisation chosen from the directory alone.
        resolution = loginContext
          ? await resolveTenantScopedUser({ ...identity, ...loginContext })
          : await resolveApplicationTenant({ ...identity, allowProvisioning: false });
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
      // Phase B / Z7: ownership is never written at sign-in. An existing user is updated only inside the
      // resolved tenant (tenantId in the write filter); a new user is created owned by it (the upsert
      // filter's tenantId). updateData carries no tenantId, so no login can move a user between tenants.
      const existingUser = resolution.existingUser;

      // Access checks for an existing user, before any write, role processing or token:
      // deactivated -> refused (as the portal); no active role in this organisation -> refused
      // (zero roles is an intentional state, never repaired at sign-in).
      if (existingUser) {
        assertCrmIdentityBinding(existingUser, profile.userMicrosoftId, tenantId);
        await assertCrmSignInAllowed(existingUser, tenantId);
      }

      // A new user (tenant-scoped login on an automatic connection only) gets the connection's
      // default role in the same atomic insert, so a role-less user is never created.
      let jitRoleId = null;
      if (!existingUser) {
        if (!loginContext || !isAutomatic(resolution.connection)) {
          // resolveTenantScopedUser / resolveApplicationTenant already refuse this; kept fail-closed.
          console.warn("Azure AD login denied:", { reason: "NOT_PROVISIONED", tenantId });
          throw AppError.forbidden("CRM sign-in is not available for this account");
        }
        try {
          jitRoleId = await resolveJitDefaultRoleId({ tenantId, connection: resolution.connection });
        } catch (err) {
          if (err instanceof DefaultRoleError) {
            throw AppError.forbidden("CRM sign-in is not available for this account");
          }
          throw err;
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

      // Atomic findOneAndUpdate. An existing user is updated by _id only while still active
      // (re-checked atomically, never upserted); a new user is inserted keyed by the Entra oid.
      const user = await User.findOneAndUpdate(
        existingUser
          ? { _id: existingUser._id, tenantId, isActive: { $ne: false }, ...crmIdentityUnchanged(existingUser) }
          : { tenantId, userMicrosoftId: profile.userMicrosoftId },
        {
          $set: updateData, // never tenantId (Z7): the owner comes from the filter
          $setOnInsert: {
            createdAt: new Date(),
            ...(jitRoleId ? { roles: [jitRoleId] } : {}),
          },
        },
        {
          upsert: !existingUser,
          new: true,
          runValidators: true,
        }
      );

      if (!user) {
        // Deactivated (or removed) concurrently: deny rather than insert.
        console.warn("Azure AD login denied:", { reason: "USER_CHANGED_DURING_LOGIN", userId: String(existingUser._id), tenantId });
        throw AppError.forbidden("CRM sign-in is not available for this account");
      }

      if (isNewUser) {
        console.log(`Created CRM user ${user._id} in tenant ${tenantId}`);
        await publishCrmUserCreated(user);
      } else {
        console.log(`Updated CRM user ${user._id} in tenant ${tenantId}`);
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
        // Only adopt the concurrently-created record of the SAME identity (a CRM user already bound
        // to this oid; never linked or re-bound here): anything else is a conflict, not a login.
        // It passes the same access checks.
        if (user) {
          if (user.userType !== "CRM" || user.userMicrosoftId !== profile.userMicrosoftId) {
            assertCrmIdentityBinding(user, profile.userMicrosoftId, tenantId);
            console.warn("Azure AD login denied:", { reason: "MICROSOFT_ID_UNBOUND_ON_RETRY", userId: String(user._id), tenantId });
            throw AppError.forbidden("CRM sign-in is not available for this account");
          }
          await assertCrmSignInAllowed(user, tenantId);
          // Update the user with latest data
          Object.assign(user, {
            ...identityProfile, // never a tenantId (Z7: ownership is not written at sign-in)
            userAuthProvider: "azure-ad",
            userType: "CRM",
            userLastLogin: new Date(),
            tokens: buildUserTokensSubdocument(null), // no Microsoft OAuth credentials (see above)
          });
          await user.save();
          return user;
        }
      }
      throw error;
    }
  }

  /**
   * Resolved configuration for this sign-in, before any Microsoft call. Tenant-scoped: the
   * connection named by the server-side state, reloaded and still an active Entra connection of
   * that organisation, then resolved (its directory + the server-side app registration). Without a
   * login context (legacy no-code login): the CRM app's home directory. A connection that is gone,
   * inactive, not enabled or (multi-directory mode) without a verified directory claim refuses the
   * sign-in (403); missing Entra configuration propagates
   * (EntraConfigError -> 500 in the controller).
   */
  static async resolveAuthConfig(loginContext) {
    if (!loginContext) {
      return resolveConnectionAuthConfig(null, { connectionType: ENTRA });
    }
    try {
      const connection = await loadLoginConnection(loginContext);
      const config = resolveConnectionAuthConfig(connection);
      // Multi-directory mode: re-checked here, so a claim removed, revoked or no longer matching
      // since the login started refuses the callback before any token request.
      await assertConnectionDirectoryClaim({ tenantId: loginContext.tenantId, connection });
      return config;
    } catch (err) {
      if (err instanceof LoginTenantError || isOrganisationConfigError(err)) {
        console.warn("Azure AD login denied:", { reason: err.code, tenantId: String(loginContext.tenantId) });
        throw AppError.forbidden(CRM_SIGN_IN_DENIED);
      }
      throw err;
    }
  }

  /**
   * @param {string} code
   * @param {string} codeVerifier
   * @param {string} expectedNonce - required; see decodeIdToken's jsdoc.
   * @param {{tenantId: string, connectionId: string}|null} [loginContext] - from the OAuth state
   *   only. The redirect URI, directory and client come from the resolved configuration, never
   *   from the request.
   */
  static async handleAzureADAuth(code, codeVerifier, expectedNonce, loginContext = null) {
    try {
      console.log("=== Azure AD Handler: Starting Authentication ===");
      console.log("Code present:", !!code);
      console.log("CodeVerifier present:", !!codeVerifier);

      // Fails closed before any Microsoft call when Entra or the connection is not usable.
      const authConfig = await this.resolveAuthConfig(loginContext);

      console.log("Step 1: Exchanging code for tokens...");
      const tokens = await this.exchangeCodeForTokens(code, codeVerifier, authConfig);
      console.log("Token exchange successful");

      console.log("Step 2: Verifying ID token...");
      const baseProfile = await this.decodeIdToken(tokens.id_token, expectedNonce, authConfig);
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
      return { user, tokens, verifiedIdentity: baseProfile.verifiedIdentity || null };
    } catch (error) {
      console.error("=== Azure AD Handler Error ===");
      if (isMicrosoftTokenError(error)) {
        // Its message embeds Microsoft's error_description: explicit fields only.
        console.error(
          "Error in handleAzureADAuth: token exchange failed",
          microsoftErrorFields(error.statusCode, error.azureError),
        );
      } else {
        console.error("Error in handleAzureADAuth:", error.message);
        console.error("Error stack:", error.stack);
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
