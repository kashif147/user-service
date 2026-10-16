const crypto = require("crypto");
const { AppError } = require("../errors/AppError");
const {
  rememberStatePolicy,
  rememberNonceForState,
} = require("../helpers/pkceStateStore");
const { resolveLoginTenant, LoginTenantError } = require("../helpers/loginTenantContext");
const { assertConnectionDirectoryClaim } = require("../helpers/directoryClaimGate");
const { EntraConfigError } = require("../helpers/entraConfig");
const {
  resolveConnectionAuthConfig,
  isOrganisationConfigError,
  AuthConfigError,
} = require("../helpers/connectionAuthConfig");
const { ENTRA, B2C } = require("../helpers/authAppRegistry");
const {
  resolveB2CPolicy,
  b2cAuthorizationUrl,
  b2cLogoutUrl,
  getDefaultPolicy,
  getSignInPolicy,
  getSignUpPolicy,
  getPasswordResetPolicy,
  getGmailCombinedPolicy,
} = require("../helpers/b2cPolicy");

/**
 * One OAuth `state` (+ its own `nonce`) per distinct B2C policy, registered for
 * POST /auth/azure-portal lookup. Same `code_verifier` / `code_challenge` for all; each
 * authorize URL must use the state for its policy or B2C will return a code this server
 * cannot map without `flow` in body. The nonce is stored alongside the state so the live
 * callback handler can verify the ID token's `nonce` claim instead of trusting an
 * unverified token blindly.
 */
function createStateForPolicies() {
  const byPolicy = new Map();
  return (policy) => {
    if (byPolicy.has(policy)) return byPolicy.get(policy);
    const s = crypto.randomBytes(12).toString("base64url");
    const nonce = crypto.randomBytes(16).toString("base64url");
    rememberStatePolicy(s, policy);
    rememberNonceForState(s, nonce);
    const result = { state: s, nonce };
    byPolicy.set(policy, result);
    return result;
  };
}

/**
 * PKCE code verifier (RFC 7636 section 4.1): 128 characters from the unreserved set, from a
 * cryptographically secure source. 96 random bytes base64url-encode to exactly 128 characters
 * of [A-Za-z0-9-_], a subset of the allowed alphabet.
 */
function generateCodeVerifier() {
  return crypto.randomBytes(96).toString("base64url");
}

/**
 * Entra settings for the CRM sign-in without an organisation code (and logout), or null (logged)
 * when Entra is not configured. No connection is selected there, so the resolver uses the CRM
 * app's home directory (legacy, existing users only; see helpers/connectionAuthConfig.js).
 */
function legacyEntraConfigOrNull() {
  try {
    return resolveConnectionAuthConfig(null, { connectionType: ENTRA });
  } catch (e) {
    if (!(e instanceof EntraConfigError)) throw e;
    console.error(e.message); // variable names only, never values
    return null;
  }
}

/** Shared (legacy) Azure B2C settings, or null (logged) when B2C is not configured. */
function b2cConfiguredOrNull() {
  try {
    return resolveConnectionAuthConfig(null, { connectionType: B2C });
  } catch (e) {
    if (!(e instanceof AuthConfigError) || e.code !== "B2C_NOT_CONFIGURED") throw e;
    console.error(e.message); // variable names only, never values
    return null;
  }
}

/** Microsoft authorize URL for a resolved Entra configuration. */
function entraAuthorizeUrl(auth, { state, nonce, codeChallenge }) {
  return (
    `${auth.authorizeEndpoint}?` +
    `client_id=${auth.clientId}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(auth.redirectUri)}&` +
    `scope=${encodeURIComponent(auth.scopes)}&` +
    `state=${state}&` +
    `nonce=${nonce}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256&` +
    // Without this, Azure AD silently re-authenticates from its own session cookie -
    // logging our own token out never touches that cookie - so a user who just logged
    // out gets signed straight back in on the next click with no credential prompt.
    `prompt=login`
  );
}

/**
 * Generate PKCE parameters for Azure AD authentication
 */
module.exports.generatePKCE = async (req, res, next) => {
  try {
    const codeVerifier = generateCodeVerifier();

    // Generate code challenge using SHA256
    const hash = crypto.createHash("sha256").update(codeVerifier).digest();
    const codeChallenge = hash
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    // Entra (CRM) authorize URL. No built-in fallbacks: without configuration there is no CRM
    // URL (B2C portal URLs below are unaffected), and a tenant-scoped CRM login is refused.
    const legacyEntra = legacyEntraConfigOrNull();
    if (!legacyEntra && req.query.tenant !== undefined) {
      return next(AppError.internalServerError("Microsoft sign-in is not configured"));
    }
    // crypto.randomBytes, not Math.random(): this state doubles as the lookup key for the
    // nonce below, so it needs to be unguessable, not just unique.
    const azureADState = crypto.randomBytes(12).toString("base64url");
    const azureADNonce = crypto.randomBytes(16).toString("base64url");

    // Tenant-scoped sign-in: ?tenant=<code> names the ProjectShell tenant this login is for. It is
    // resolved to that tenant's one active Entra connection, whose resolved configuration (its
    // directory + the server-side app registration) builds the authorize URL; {tenantId,
    // connectionId} are bound to the state server-side and the callback restores them from the
    // state only. Without ?tenant the login uses the legacy directory-wide lookup (existing users
    // only; CRM builds that predate tenant-scoped sign-in).
    let loginContext = null;
    let entra = legacyEntra;
    if (req.query.tenant !== undefined) {
      try {
        const selected = await resolveLoginTenant(req.query.tenant);
        entra = resolveConnectionAuthConfig(selected.connection);
        // Multi-directory mode: the directory must be verified for this organisation and connection.
        await assertConnectionDirectoryClaim({ tenantId: selected.tenantId, connection: selected.connection });
        loginContext = { tenantId: selected.tenantId, connectionId: selected.connectionId };
      } catch (e) {
        if (e instanceof LoginTenantError || isOrganisationConfigError(e)) {
          console.warn("Tenant-scoped sign-in refused:", { reason: e.code });
          // Same message for unknown and unconfigured tenants (no tenant-code enumeration).
          return next(AppError.badRequest("Microsoft sign-in is not available for this organisation"));
        }
        throw e;
      }
    }
    let azureADAuthUrl = null;
    if (entra) {
      rememberNonceForState(azureADState, azureADNonce, loginContext);
      azureADAuthUrl = entraAuthorizeUrl(entra, {
        state: azureADState,
        nonce: azureADNonce,
        codeChallenge,
      });
    }

    // Shared (legacy) B2C portal URLs, only when B2C is configured: no built-in tenant/client
    // fallbacks, and a missing B2C configuration never breaks the CRM sign-in above.
    if (!b2cConfiguredOrNull()) {
      return res.json({
        success: true,
        codeVerifier,
        codeChallenge,
        codeChallengeMethod: "S256",
        state: null,
        b2cPolicies: null,
        authorizationUrls: { azureAD: azureADAuthUrl },
      });
    }

    let selectedPolicy;
    try {
      selectedPolicy = resolveB2CPolicy({
        flow: req.query.flow,
        policy: req.query.policy,
      });
    } catch (e) {
      return next(AppError.badRequest(e.message));
    }

    const stateForPolicy = createStateForPolicies();
    const b2cSignIn = getSignInPolicy();
    const b2cSignUp = getSignUpPolicy();
    const passwordResetPolicy = getPasswordResetPolicy();

    const selectedStateNonce = stateForPolicy(selectedPolicy);
    const signInStateNonce = stateForPolicy(b2cSignIn);
    const signUpStateNonce = stateForPolicy(b2cSignUp);
    const passwordResetStateNonce = stateForPolicy(passwordResetPolicy);

    const b2cAuthUrl = b2cAuthorizationUrl(selectedPolicy, {
      state: selectedStateNonce.state,
      codeChallenge,
      nonce: selectedStateNonce.nonce,
    });
    const b2cAuthUrlSignIn = b2cAuthorizationUrl(b2cSignIn, {
      state: signInStateNonce.state,
      codeChallenge,
      nonce: signInStateNonce.nonce,
    });
    const b2cAuthUrlSignUp = b2cAuthorizationUrl(b2cSignUp, {
      state: signUpStateNonce.state,
      codeChallenge,
      nonce: signUpStateNonce.nonce,
    });
    const b2cAuthUrlPasswordReset = b2cAuthorizationUrl(passwordResetPolicy, {
      state: passwordResetStateNonce.state,
      codeChallenge,
      nonce: passwordResetStateNonce.nonce,
    });

    const b2cPolicies = {
      default: getDefaultPolicy(),
      selected: selectedPolicy,
      signIn: b2cSignIn,
      signUp: b2cSignUp,
      passwordReset: passwordResetPolicy,
    };
    const authorizationUrls = {
      azureAD: azureADAuthUrl,
      azureB2C: b2cAuthUrl,
      azureB2CSignIn: b2cAuthUrlSignIn,
      azureB2CSignUp: b2cAuthUrlSignUp,
      azureB2CPasswordReset: b2cAuthUrlPasswordReset,
    };

    if (process.env.MS_POLICY_GMAIL_COMBINED) {
      const gmailPolicy = getGmailCombinedPolicy();
      const gmailStateNonce = stateForPolicy(gmailPolicy);
      b2cPolicies.gmailCombined = gmailPolicy;
      authorizationUrls.azureB2CGmailCombined = b2cAuthorizationUrl(
        gmailPolicy,
        {
          state: gmailStateNonce.state,
          codeChallenge,
          nonce: gmailStateNonce.nonce,
        },
      );
    }

    // Only the state is returned to the client; the nonce stays server-side and is
    // recovered from the state on callback (see takeNonceForState in the auth handlers).
    const primaryB2CState = selectedStateNonce.state;

    res.json({
      success: true,
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: "S256",
      state: primaryB2CState,
      b2cPolicies,
      authorizationUrls,
      instructions: {
        step1:
          "Open ONE B2C URL from this response. Each URL uses a different `state` that maps to the correct user flow. GET ?flow=signin|signup|gmail|... selects the primary `authorizationUrls.azureB2C`",
        step2: "From the redirect, copy `code` and `state` (they match the user flow you used)",
        step3:
          "POST /auth/azure-portal: { code, codeVerifier, state } — `state` maps to the B2C policy; you can omit `flow`/`policy` if `state` is sent. Still valid to send `flow` or `policy` to override",
        step4:
          "AADB2C90088 means the wrong token policy was used; use `state` from the same redirect, or re-run PKCE and use one link only per login",
      },
    });
  } catch (error) {
    console.error("PKCE generation error:", error);
    return next(
      AppError.internalServerError("Failed to generate PKCE parameters"),
    );
  }
};

/**
 * Front-channel logout URLs for both flows. Clearing this app's own token/localStorage on
 * logout never touches Microsoft's own session cookie (login.microsoftonline.com /
 * *.b2clogin.com) - only navigating the browser to Microsoft's logout endpoint does. No
 * auth required: these URLs contain nothing sensitive, they're meant to be navigated to.
 *
 * post_logout_redirect_uri reuses each flow's existing login redirect_uri, since that's
 * necessarily already registered with Microsoft for this app; landing back there with no
 * `code` query param is a harmless no-op on the login page. Depending on the app
 * registration / B2C user flow configuration, Microsoft may also require
 * post_logout_redirect_uri to be listed explicitly as a "front-channel logout URL" - if
 * the redirect-back doesn't happen, that's the first thing to check (the session-clearing
 * part still succeeds either way; only the redirect-back is affected).
 */
module.exports.getLogoutUrls = async (req, res, next) => {
  try {
    // Logout carries no organisation, so the legacy (home-directory) Entra configuration is used.
    const entra = legacyEntraConfigOrNull();
    const azureADLogoutUrl = entra
      ? `${entra.logoutEndpoint}?` +
        `post_logout_redirect_uri=${encodeURIComponent(entra.redirectUri)}`
      : null;

    const b2c = b2cConfiguredOrNull();
    const b2cLogoutUrlValue = b2c ? b2cLogoutUrl(getSignInPolicy(), b2c.redirectUri) : null;

    return res.json({
      success: true,
      azureADLogoutUrl,
      b2cLogoutUrl: b2cLogoutUrlValue,
    });
  } catch (error) {
    console.error("Logout URL generation error:", error);
    return next(
      AppError.internalServerError("Failed to generate logout URLs"),
    );
  }
};

module.exports._generateCodeVerifier = generateCodeVerifier;
