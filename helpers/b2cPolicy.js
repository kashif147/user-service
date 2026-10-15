/**
 * Azure AD B2C user flow (policy) resolution.
 * Authorize and token endpoints must use the same policy name for a given auth code.
 */
const { resolveConnectionAuthConfig } = require("./connectionAuthConfig");

function getDefaultPolicy() {
  return (
    process.env.MS_POLICY ||
    process.env.MS_POLICY_NAME ||
    "B2C_1_projectshell_signin"
  );
}

function getSignInPolicy() {
  return process.env.MS_POLICY_SIGNIN || getDefaultPolicy();
}

function getSignUpPolicy() {
  return process.env.MS_POLICY_SIGNUP || getDefaultPolicy();
}

function getPasswordResetPolicy() {
  return process.env.MS_POLICY_PASSWORD_RESET || getDefaultPolicy();
}

/**
 * Google-only (or other) combined sign-in/sign-up user flow, e.g. one SPA button.
 * Set MS_POLICY_GMAIL_COMBINED to the B2C policy name; use POST/GET flow=gmail|google|gmail-combined.
 */
function getGmailCombinedPolicy() {
  return process.env.MS_POLICY_GMAIL_COMBINED || getDefaultPolicy();
}

function getAllowedPolicies() {
  const set = new Set();
  const add = (p) => {
    if (p && typeof p === "string" && p.trim()) set.add(p.trim());
  };
  add(getDefaultPolicy());
  add(process.env.MS_POLICY);
  add(process.env.MS_POLICY_NAME);
  add(process.env.MS_POLICY_SIGNIN);
  add(process.env.MS_POLICY_SIGNUP);
  add(process.env.MS_POLICY_PASSWORD_RESET);
  add(process.env.MS_POLICY_GMAIL_COMBINED);
  (process.env.MS_B2C_POLICIES || "")
    .split(",")
    .forEach((s) => add(s));
  return set;
}

function isValidPolicyId(p) {
  return typeof p === "string" && p.length <= 128 && /^[a-zA-Z0-9._-]+$/.test(p);
}

/**
 * Resolve which B2C user flow to use for authorize + token exchange.
 * @param {{ flow?: string, policy?: string }} input
 * @returns {string}
 */
function resolveB2CPolicy(input = {}) {
  const { flow, policy } = input;
  const allowed = getAllowedPolicies();

  if (policy != null && String(policy).trim() !== "") {
    const p = String(policy).trim();
    if (!isValidPolicyId(p)) {
      throw new Error("Invalid policy value");
    }
    if (!allowed.has(p)) {
      throw new Error(
        "Policy is not enabled for this application. Set MS_POLICY_SIGNIN, MS_POLICY_SIGNUP, MS_POLICY_PASSWORD_RESET, MS_POLICY_GMAIL_COMBINED, MS_B2C_POLICIES, or MS_POLICY / MS_POLICY_NAME.",
      );
    }
    return p;
  }

  if (flow != null && String(flow).trim() !== "") {
    const f = String(flow).trim().toLowerCase();
    if (f === "signin" || f === "login") {
      return getSignInPolicy();
    }
    if (f === "signup" || f === "register") {
      return getSignUpPolicy();
    }
    if (
      f === "password-reset" ||
      f === "passwordreset" ||
      f === "resetpassword" ||
      f === "reset"
    ) {
      return getPasswordResetPolicy();
    }
    if (f === "gmail" || f === "google" || f === "gmail-combined") {
      return getGmailCombinedPolicy();
    }
    throw new Error(
      'flow must be "signin", "signup", "gmail", "google", "password-reset", "login", "register", or "reset" (or send policy explicitly)',
    );
  }

  return getDefaultPolicy();
}

// Endpoints, client id, redirect URI and issuer come from the resolved (legacy shared) B2C
// configuration (helpers/connectionAuthConfig.js -> helpers/authAppRegistry.js). There are no
// built-in tenant, client id or redirect fallbacks: missing configuration fails closed. The
// b2clogin.com host is always lower case: B2C issues `iss` with the lower-case tenant host, and
// jose's issuer check is an exact string comparison.
function b2cConfig(policyName) {
  return resolveConnectionAuthConfig(null, { connectionType: "Azure B2C", policy: policyName });
}

function b2cTokenEndpoint(policyName) {
  return b2cConfig(policyName).tokenEndpoint;
}

/**
 * @param {string} policyName
 * @param {{ state: string, codeChallenge: string, nonce?: string }} opts
 */
function b2cAuthorizationUrl(policyName, opts) {
  const { state, codeChallenge, nonce } = opts;
  const config = b2cConfig(policyName);
  const q = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Without this, B2C silently re-authenticates from its own session cookie
    // (login.microsoftonline.com/*.b2clogin.com is a separate session from this app's -
    // clearing our own token/localStorage on logout never touches it), so a user who just
    // logged out gets signed straight back in on the next click with no credential prompt.
    prompt: "login",
  });
  if (nonce) {
    q.set("nonce", nonce);
  }
  return `${config.authorizeEndpoint}?${q.toString()}`;
}

/**
 * B2C logout endpoint for a given policy - ends that policy's session cookie in the
 * browser. Distinct per policy, like the authorize/token/JWKS endpoints.
 * `postLogoutRedirectUri` should be a value already registered for this app (the existing
 * login redirect_uri is a safe choice - it's necessarily already registered, and landing
 * back on the login page with no `code` param is a harmless no-op there).
 * @param {string} policyName
 * @param {string} postLogoutRedirectUri
 * @returns {string}
 */
function b2cLogoutUrl(policyName, postLogoutRedirectUri) {
  const q = new URLSearchParams({
    post_logout_redirect_uri: postLogoutRedirectUri,
  });
  return `${b2cConfig(policyName).logoutEndpoint}?${q.toString()}`;
}

/**
 * JWKS discovery URL for a given B2C policy. Azure AD B2C publishes signing keys per policy,
 * so the JWKS used to verify a token must match the policy that issued it.
 * @param {string} policyName
 * @returns {string}
 */
function b2cJwksUrl(policyName) {
  return b2cConfig(policyName).jwksUri;
}

/**
 * Expected `iss` claim for the shared B2C directory: built from the fixed, admin-configured
 * directory GUID (MS_B2C_DIRECTORY_ID via the app registry), never from a claim inside the token
 * being verified (that would make signature verification circular).
 * @returns {string}
 */
function b2cExpectedIssuer() {
  return b2cConfig().issuer;
}

module.exports = {
  getDefaultPolicy,
  getSignInPolicy,
  getSignUpPolicy,
  getPasswordResetPolicy,
  getGmailCombinedPolicy,
  getAllowedPolicies,
  resolveB2CPolicy,
  b2cTokenEndpoint,
  b2cAuthorizationUrl,
  b2cLogoutUrl,
  b2cJwksUrl,
  b2cExpectedIssuer,
};
