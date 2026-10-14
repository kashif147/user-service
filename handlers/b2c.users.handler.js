const axios = require("axios");
const { jwtVerify, createRemoteJWKSet } = require("jose");
const B2CUser = require("../models/user.model");
const Tenant = require("../models/tenant.model");
const { AppError } = require("../errors/AppError");
const { resolveApplicationTenant, IdentityTenantError } = require("../helpers/identityTenantResolution");
const {
  isAutomatic,
  resolveJitDefaultRoleId,
  hasActiveRoleInTenant,
  DefaultRoleError,
} = require("../helpers/connectionDefaultRole");
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

// Public message for every portal sign-in refusal; the specific reason is logged server-side only.
const PORTAL_SIGN_IN_DENIED = "Portal sign-in is not available for this account";

// A portal (B2C) login may only sign in as an active PORTAL user. A CRM user with the same email is
// never converted to PORTAL (it would carry its CRM roles into a portal token), and a deactivated
// user gets no token, lastLogin update or role sync.
function assertPortalSignInAllowed(user) {
  let reason = null;
  if (user.userType && user.userType !== "PORTAL") reason = "NON_PORTAL_USER";
  else if (user.isActive === false) reason = "INACTIVE_USER";
  if (reason) {
    console.warn("B2C login denied:", { reason, userId: String(user._id), tenantId: user.tenantId });
    throw AppError.forbidden(PORTAL_SIGN_IN_DENIED);
  }
}

// Public message for a portal user without any active role in the organisation.
const NO_ORGANISATION_ACCESS = "You don't have access to this organisation";

// Zero active roles in the organisation is an intentional state (e.g. an administrator removed
// them): the user is refused before any update, membership-role sync or token, never repaired.
async function assertPortalUserHasAccess(user, tenantId) {
  if (!(await hasActiveRoleInTenant(user, tenantId))) {
    console.warn("B2C login denied:", { reason: "NO_ACTIVE_ROLE", userId: String(user._id), tenantId });
    throw AppError.forbidden(NO_ORGANISATION_ACCESS);
  }
}

// Legacy migration: a PORTAL user whose tenantId predates Tenant mapping (not an existing Tenant).
// Returns it only when exactly one such user exists for the email; never a user in a real tenant.
async function findLegacyPortalUser(email, tenantId) {
  const candidates = await B2CUser.find({
    userEmail: email,
    tenantId: { $ne: tenantId },
  }).lean();
  const legacy = [];
  for (const candidate of candidates) {
    if (candidate.userType && candidate.userType !== "PORTAL") continue;
    const tid = String(candidate.tenantId || "");
    const isRealTenant =
      /^[0-9a-f]{24}$/i.test(tid) && (await Tenant.exists({ _id: tid }));
    if (!isRealTenant) legacy.push(candidate);
  }
  return legacy.length === 1 ? legacy[0] : null;
}

const CLIENT_ID =
  process.env.MS_CLIENT_ID || "e3688a2f-3956-42f9-8c98-6fea7a60a5b4";
const REDIRECT_URI = process.env.MS_REDIRECT_URI || "http://localhost:3000";

class B2CUsersHandler {
  static async exchangeCodeForTokens(code, codeVerifier, policyName) {
    const tokenEndpoint = b2cTokenEndpoint(policyName);
    // Never log the authorization code, the PKCE verifier or the request body built from them.
    console.log("B2C token exchange:", { policy: policyName });

    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      scope: "openid offline_access",
    });

    try {
      const response = await axios.post(tokenEndpoint, data.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      console.log("B2C token exchange succeeded:", {
        idToken: Boolean(response.data.id_token),
        refreshToken: Boolean(response.data.refresh_token),
      });

      return response.data;
    } catch (error) {
      // Status and Microsoft's error code only: the HTTP client error carries the request
      // (code + verifier) in its config, so it is never logged whole.
      console.log("B2C token exchange failed:", {
        status: error.response?.status || null,
        error: error.response?.data?.error || error.code || null,
      });
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
    // use that fixed, trusted value rather than deriving a directory ID from token claims
    // (tid/extension_tenantId/tenantId/iss). The directory never selects a ProjectShell tenant
    // (several tenants share the B2C directory): findOrCreateUser resolves the tenant from the
    // user's own record (helpers/identityTenantResolution.js).
    const extractedDirectoryId = process.env.MS_B2C_DIRECTORY_ID;

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
      // Microsoft directory id, kept for reference; not a ProjectShell tenant
      microsoftDirectoryId: extractedDirectoryId,
    };
  }

  static async findOrCreateUser(profile, tokens) {
    const email = profile.userEmail;
    // decodeIdToken validated the trusted B2C directory; the APPLICATION tenant is resolved below
    // from the ProjectShell user record (helpers/identityTenantResolution.js). Any tenantId on
    // the profile is ignored.
    let tenantId = null;
    if (!email) {
      console.log("B2C sign-in: token has no email claim");
      throw new Error("Email not found in Microsoft token");
    }
    const identityProfile = { ...profile };
    delete identityProfile.tenantId;
    const updateData = {
      ...identityProfile,
      userAuthProvider: "microsoft",
      userType: "PORTAL", // Ensure portal users are marked as PORTAL type
      userLastLogin: new Date(),
      tokens: buildUserTokensSubdocument(tokens),
      updatedAt: new Date(),
    };

    try {
      // Application tenant = the portal user's own tenant among the tenants that trust this B2C
      // directory (several tenants may share it); new users are provisioned only into the single
      // auto-provisioning tenant. The directory never assigns or rewrites a user's tenant.
      let resolution;
      try {
        resolution = await resolveApplicationTenant({
          connectionType: "Azure B2C",
          directoryId: profile.microsoftDirectoryId,
          email,
          microsoftId: profile.userMicrosoftId,
          UserModel: B2CUser,
        });
      } catch (err) {
        if (err instanceof IdentityTenantError) {
          console.warn("B2C login denied:", { reason: err.code });
          throw AppError.forbidden(PORTAL_SIGN_IN_DENIED);
        }
        throw err;
      }
      tenantId = resolution.tenantId;
      updateData.tenantId = tenantId;
      let existingUser = resolution.existingUser;

      // If not found, look for a legacy PORTAL user created before tenant mapping (its tenantId is
      // not a real Tenant). Only that user is migrated to the resolved tenantId: a user in another
      // real tenant, or a CRM user, is never moved - a new PORTAL user is created instead.
      let migratingLegacyUser = false;
      if (!existingUser) {
        existingUser = await findLegacyPortalUser(email, tenantId);
        migratingLegacyUser = !!existingUser;
      }

      if (existingUser) {
        assertPortalSignInAllowed(existingUser);
        // A legacy user's roles belong to its pre-mapping tenant; it is provisioned below instead.
        if (!migratingLegacyUser) await assertPortalUserHasAccess(existingUser, tenantId);
      }

      const isNewUser = !existingUser;

      // New (or legacy-migrated) users only arrive here through the single automatic connection
      // (resolveApplicationTenant); they get its default role in the same atomic write, so a
      // role-less portal user is never created.
      let jitRoleId = null;
      if (isNewUser || migratingLegacyUser) {
        if (!isAutomatic(resolution.connection)) {
          console.warn("B2C login denied:", { reason: "NOT_PROVISIONED", tenantId });
          throw AppError.forbidden(PORTAL_SIGN_IN_DENIED);
        }
        try {
          jitRoleId = await resolveJitDefaultRoleId({ tenantId, connection: resolution.connection });
        } catch (err) {
          if (err instanceof DefaultRoleError) throw AppError.forbidden(PORTAL_SIGN_IN_DENIED);
          throw err;
        }
      }

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

      // Use atomic findOneAndUpdate with upsert to prevent race conditions. A vetted existing user is
      // updated by _id (still PORTAL + active, re-checked atomically); otherwise insert by email + tenant.
      const user = await B2CUser.findOneAndUpdate(
        existingUser
          ? {
              _id: existingUser._id,
              userType: { $ne: "CRM" },
              isActive: { $ne: false },
            }
          : { userEmail: email, tenantId: tenantId },
        {
          $set: migratingLegacyUser ? { ...updateData, roles: [jitRoleId] } : updateData, // includes tenantId (Tenant._id)
          $setOnInsert: {
            createdAt: new Date(),
            ...(isNewUser && jitRoleId ? { roles: [jitRoleId] } : {}),
          },
        },
        {
          upsert: !existingUser,
          new: true,
          runValidators: true,
        },
      );

      if (!user) {
        // The vetted user was converted/deactivated concurrently: deny rather than insert.
        console.warn("B2C login denied:", { reason: "USER_CHANGED_DURING_LOGIN", userId: String(existingUser._id) });
        throw AppError.forbidden(PORTAL_SIGN_IN_DENIED);
      }

      await syncPortalUserRolesFromMembership(user, email, tenantId, {
        isNewUser,
      });

      if (isNewUser) {
        await publishPortalUserCreated(user);
      } else {
        await publishPortalUserUpdated(user, previousValues);
      }

      console.log("B2C sign-in resolved:", {
        provider: "azure-b2c",
        userId: String(user._id),
        tenantId,
        outcome: isNewUser ? "provisioned" : "existing",
      });
      return user;
    } catch (error) {
      console.log("B2C sign-in failed:", { name: error.name, code: error.code || null });
      // Handle duplicate key errors (E11000) that might still occur in edge cases
      if (error.code === 11000) {
        // User was created by another request, fetch and return it
        console.log(`Duplicate key on PORTAL user upsert in tenant ${tenantId}; re-reading the existing record`);
        const user = await B2CUser.findOne({
          userEmail: email,
          tenantId: tenantId,
        });
        if (user) {
          assertPortalSignInAllowed(user);
          await assertPortalUserHasAccess(user, tenantId);
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
