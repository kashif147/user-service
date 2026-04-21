/**
 * Azure AD B2C user flow (policy) resolution.
 * Authorize and token endpoints must use the same policy name for a given auth code.
 */

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
        "Policy is not enabled for this application. Set MS_POLICY_SIGNIN, MS_POLICY_SIGNUP, MS_POLICY_PASSWORD_RESET, MS_B2C_POLICIES, or MS_POLICY / MS_POLICY_NAME.",
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
    throw new Error(
      'flow must be "signin", "signup", "password-reset", "login", "register", or "reset" (or send policy explicitly)',
    );
  }

  return getDefaultPolicy();
}

function b2cTokenEndpoint(policyName) {
  const tenant = process.env.MS_TENANT_NAME || "projectshellAB2C";
  return `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/${policyName}/oauth2/v2.0/token`;
}

/**
 * @param {string} policyName
 * @param {{ state: string, codeChallenge: string }} opts
 */
function b2cAuthorizationUrl(policyName, opts) {
  const { state, codeChallenge } = opts;
  const tenant = process.env.MS_TENANT_NAME || "projectshellAB2C";
  const clientId =
    process.env.MS_CLIENT_ID || "e3688a2f-3956-42f9-8c98-6fea7a60a5b4";
  const redirectUri =
    process.env.MS_REDIRECT_URI || "http://localhost:3000";
  const base = `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/${policyName}/oauth2/v2.0/authorize`;
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid offline_access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${base}?${q.toString()}`;
}

module.exports = {
  getDefaultPolicy,
  getSignInPolicy,
  getSignUpPolicy,
  getPasswordResetPolicy,
  getAllowedPolicies,
  resolveB2CPolicy,
  b2cTokenEndpoint,
  b2cAuthorizationUrl,
};
