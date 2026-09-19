/**
 * Test-only helpers for generating real RS256-signed JWTs against a throwaway keypair,
 * and a local JWKS built from that keypair - used to exercise the remediation's
 * signature/issuer/audience/algorithm/exp/nbf verification without depending on
 * network access to a real Microsoft tenant.
 */
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require("jose");

const KID = "test-key-1";

async function makeTestKeypairAndJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return { privateKey, jwks };
}

/**
 * @param {CryptoKey} privateKey
 * @param {object} claims - payload claims (iss/aud/exp/nbf/etc merged in)
 * @param {object} [options]
 * @param {string} [options.kid] - override kid (e.g. to simulate an unknown key)
 * @param {number} [options.expiresInSeconds] - relative expiry from now
 */
async function signTestJwt(privateKey, claims, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  let builder = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? KID })
    .setIssuedAt(now);

  if (options.expiresInSeconds !== undefined) {
    builder = builder.setExpirationTime(now + options.expiresInSeconds);
  } else if (claims.exp === undefined) {
    builder = builder.setExpirationTime(now + 3600);
  }

  return builder.sign(privateKey);
}

/** Builds an unsigned-but-structurally-valid JWT (alg "none", empty signature segment). */
function makeUnsignedJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

/** Tampers a signed JWT's payload segment without re-signing, to simulate a modified
 * payload with the original signature. */
function tamperPayload(token, mutateClaims) {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  const mutated = mutateClaims(claims);
  const newPayloadB64 = Buffer.from(JSON.stringify(mutated)).toString("base64url");
  return `${headerB64}.${newPayloadB64}.${sigB64}`;
}

module.exports = {
  KID,
  makeTestKeypairAndJwks,
  signTestJwt,
  makeUnsignedJwt,
  tamperPayload,
};
