/**
 * Stage 5c "Connect Microsoft Entra" (backend): a directory administrator signs in through the
 * shared CRM application against the `organizations` authority, and the VERIFIED ID token proves
 * which directory this is (tid) and that the person may connect it (signed `wids` directory roles).
 *
 *  - Authorization code + PKCE (S256); scopes openid profile email (no refresh token).
 *  - Verified: RS256 signature against the `organizations` keys, audience = the shared CRM client
 *    id, issuer = https://login.microsoftonline.com/{tid}/v2.0 for the token's own tid, nonce,
 *    exp / nbf, iat no older than 10 minutes, tid a directory GUID (never the personal-account
 *    directory), oid a GUID.
 *  - Administrator: only the signed `wids` claim counts (active directory-role assignments; a
 *    PIM-eligible role that is not activated is not in it). A successful sign-in or consent alone
 *    proves nothing; app roles, groups, scp and anything from the request are never used.
 *  - Nothing here stores or logs a token, code or verifier: only the ID token is read, in memory.
 */
const crypto = require("crypto");
const { jwtVerify, createRemoteJWKSet } = require("jose");
// Priority order (helpers/directoryClaimPolicy.js): the first match is recorded as the evidence role.
const { normalizeDirectoryId, DIRECTORY_GUID, ADMIN_ROLE_TEMPLATE_IDS } = require("./directoryClaimPolicy");

const MAX_TOKEN_AGE_SECONDS = 10 * 60;

class EntraConnectError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "EntraConnectError";
    this.code = code;
  }
}

const jwksByUri = new Map();
function getJwks(uri) {
  if (!jwksByUri.has(uri)) jwksByUri.set(uri, createRemoteJWKSet(new URL(uri)));
  return jwksByUri.get(uri);
}
/** Test hook: a local key set for `uri`; null clears all. */
function _setJwksForTests(jwks, uri) {
  if (!jwks) return jwksByUri.clear();
  jwksByUri.set(uri, jwks);
}

/** State, nonce and PKCE verifier/challenge for one Connect transaction (all server-generated). */
function newConnectSecrets() {
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  return {
    state: crypto.randomBytes(32).toString("base64url"),
    nonce: crypto.randomBytes(16).toString("base64url"),
    codeVerifier,
    codeChallenge: crypto.createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

function buildConnectAuthorizeUrl(config, { state, nonce, codeChallenge }) {
  const url = new URL(config.authorizeEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    response_mode: "query",
    scope: config.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/** First accepted administrator role template in a verified `wids` value, else null. */
function matchAdminRole(wids) {
  if (!Array.isArray(wids) || wids.length === 0) return null;
  const held = new Set();
  for (const w of wids) {
    if (typeof w !== "string" || !DIRECTORY_GUID.test(w)) return null;
    held.add(w.toLowerCase());
  }
  return ADMIN_ROLE_TEMPLATE_IDS.find((id) => held.has(id)) || null;
}

/**
 * Verifies a Connect ID token and returns only what Connect needs.
 * @returns {Promise<{directoryId: string, directoryUserId: string, roleTemplateId: string}>}
 * @throws {EntraConnectError} TOKEN_INVALID | INVALID_DIRECTORY | NOT_DIRECTORY_ADMIN
 */
async function verifyConnectIdToken(idToken, expectedNonce, config) {
  if (typeof idToken !== "string" || !expectedNonce || !config?.jwksUri) {
    throw new EntraConnectError("TOKEN_INVALID", "Microsoft sign-in could not be verified");
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getJwks(config.jwksUri), {
      audience: config.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "iat", "tid", "oid", "nonce"],
    }));
  } catch {
    throw new EntraConnectError("TOKEN_INVALID", "Microsoft sign-in could not be verified");
  }
  const directoryId = normalizeDirectoryId(payload.tid);
  if (!directoryId || payload.tid !== directoryId) {
    throw new EntraConnectError("INVALID_DIRECTORY", "This Microsoft account directory cannot be connected");
  }
  const checks = [
    payload.iss === config.issuerTemplate.replace("{tid}", directoryId),
    payload.nonce === expectedNonce,
    typeof payload.oid === "string" && DIRECTORY_GUID.test(payload.oid),
    Math.floor(Date.now() / 1000) - Number(payload.iat) <= MAX_TOKEN_AGE_SECONDS,
  ];
  if (checks.includes(false)) {
    throw new EntraConnectError("TOKEN_INVALID", "Microsoft sign-in could not be verified");
  }
  const roleTemplateId = matchAdminRole(payload.wids);
  if (!roleTemplateId) {
    throw new EntraConnectError("NOT_DIRECTORY_ADMIN", "A Microsoft Entra administrator of this directory must connect it");
  }
  return { directoryId, directoryUserId: payload.oid.toLowerCase(), roleTemplateId };
}

module.exports = {
  ADMIN_ROLE_TEMPLATE_IDS,
  EntraConnectError,
  newConnectSecrets,
  buildConnectAuthorizeUrl,
  matchAdminRole,
  verifyConnectIdToken,
  _setJwksForTests,
};
