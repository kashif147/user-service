const { jwtVerify, createRemoteJWKSet } = require("jose");

/**
 * Verifies a Microsoft/Azure AD RS256 access or ID token's cryptographic signature,
 * issuer, audience, algorithm, tenant, and expiry/not-before, for the CURRENT
 * single-tenant ProjectShell deployment (one company Azure AD tenant, AZURE_AD_TENANT_ID).
 *
 * Why this lives here instead of in the nginx/OpenResty gateway (config/verify_jwt.lua):
 * verify_jwt.lua's RS256 branch previously checked `tid`/`aud`/`exp` claim VALUES with no
 * signature verification at all ("SAFE MODE - NO RS256 CRYPTO", see the 2026-09-16 gateway
 * review). Doing real JWKS verification (fetch, cache, kid-based key selection, JWK->key
 * conversion) correctly inside bare OpenResty Lua would mean hand-rolling cryptographic
 * plumbing this codebase has no proven implementation of and no confirmed Lua rocks
 * (resty.http/resty.openidc) installed for - exactly the "custom cryptography" the
 * remediation brief says not to build. `jose` is already a proven, correct pattern in this
 * service (see controllers/sessions.controller.js's validateB2CToken and
 * portal-service/controllers/auth.controller.js's validateIdToken) and already a listed
 * dependency here. So the gateway (config/verify_jwt.lua) delegates RS256 verification to
 * this endpoint via an nginx internal subrequest instead of doing the crypto itself - see
 * the `internal;` location in frontend/ProjectShell-1/default.conf.
 *
 * Gated by a shared secret (requireInternalSecret below), the same pattern as
 * controllers/internalRoleAccess.controller.js, not a bare x-internal-request flag - chosen
 * because a successful call here is equivalent to establishing a fully trusted identity for
 * every downstream service, a materially higher-stakes surface than that endpoint's PII
 * reads.
 *
 * Deliberately single-tenant: issuer, audience, and JWKS URL are all built from fixed env
 * vars, never from the token's own (unverified, at that point) claims - and `tid` is
 * re-checked explicitly below even though the issuer URL already encodes the tenant, as
 * defense in depth. No per-customer tenant lookup here; that is out of scope for this
 * remediation.
 */

const AZURE_AD_TENANT_ID = process.env.AZURE_AD_TENANT_ID;
const BACKEND_API_APP_ID = process.env.BACKEND_API_APP_ID;

let jwksSingleton = null;

/**
 * Lazily creates (and reuses) the remote JWKS set for the single configured Azure AD
 * tenant. `createRemoteJWKSet` handles kid-based key selection, fetch caching, and
 * rate-limited re-fetch on an unrecognized `kid` internally - this is exactly the safe,
 * standard mechanism the remediation brief asks for instead of hand-rolled JWK parsing.
 */
function getJwks() {
  if (!jwksSingleton) {
    if (!AZURE_AD_TENANT_ID) {
      throw new Error("AZURE_AD_TENANT_ID is not configured");
    }
    jwksSingleton = createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}/discovery/v2.0/keys`,
      ),
    );
  }
  return jwksSingleton;
}

/** Exposed for tests only, so a forged-signature test can inject a JWKS pointed at a
 * throwaway keypair instead of a real Microsoft tenant. */
function _resetJwksForTests(jwks) {
  jwksSingleton = jwks || null;
}

function requireInternalSecret(req, res, next) {
  const secret = process.env.GATEWAY_VERIFY_SECRET;
  if (!secret || req.headers["x-service-secret"] !== secret) {
    return res.status(403).json({ verified: false, error: "Forbidden" });
  }
  return next();
}

async function verifyMsToken(req, res) {
  try {
    const token = req.body && req.body.token;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ verified: false, error: "Missing token" });
    }
    if (!AZURE_AD_TENANT_ID || !BACKEND_API_APP_ID) {
      console.error(
        "verifyMsToken: server not configured (missing AZURE_AD_TENANT_ID or BACKEND_API_APP_ID)",
      );
      return res
        .status(500)
        .json({ verified: false, error: "Server not configured for token verification" });
    }

    const expectedIssuer = `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}/v2.0`;
    const expectedAudience = `api://${BACKEND_API_APP_ID}`;

    // jwtVerify throws before returning any payload if the signature, issuer, audience,
    // algorithm, exp, or nbf checks fail (jose validates exp/nbf automatically whenever
    // those claims are present) - so nothing below this line is reachable with an
    // unverified/forged/tampered/expired/not-yet-valid/wrong-issuer/wrong-audience token.
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ["RS256"],
    });

    // Explicit tenant check as defense in depth, even though `expectedIssuer` already
    // encodes AZURE_AD_TENANT_ID and jose already validated `iss` against it above.
    if (payload.tid !== AZURE_AD_TENANT_ID) {
      console.error(
        "verifyMsToken: token passed signature/issuer checks but tid mismatch",
        { expectedTenant: AZURE_AD_TENANT_ID },
      );
      return res.status(401).json({ verified: false, error: "Token verification failed" });
    }

    return res.status(200).json({
      verified: true,
      tid: payload.tid,
      oid: payload.oid || null,
      sub: payload.sub || null,
      clientAppId: payload.appid || payload.azp || null,
      idtyp: payload.idtyp || null,
      scp: payload.scp || null,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
      preferred_username: payload.preferred_username || "",
      exp: payload.exp || null,
    });
  } catch (error) {
    // Never return the raw error (can echo back attacker-controlled token fragments) or
    // the token itself; log a sanitized diagnostic server-side only.
    console.error("verifyMsToken: verification failed", { name: error.name });
    return res.status(401).json({ verified: false, error: "Token verification failed" });
  }
}

module.exports = {
  requireInternalSecret,
  verifyMsToken,
  _resetJwksForTests,
};
