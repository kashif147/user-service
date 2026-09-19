/**
 * In-memory map: B2C authorize `state` -> user flow (policy) name.
 * Filled in GET /pkce/generate (one state per unique policy in the response) and
 * consumed in POST /auth/azure-portal so the client can send { code, codeVerifier, state }
 * and the server picks the right token endpoint for all workflows.
 *
 * For multi-replica production, replace with Redis with the same key/TTL.
 */

const TTL_MS = 10 * 60 * 1000;
const store = new Map();

/**
 * Separate in-memory map: authorize `state` -> OIDC `nonce`.
 * Used for both the Azure AD (CRM) and Azure B2C (Portal) authorize URLs so the live
 * login handlers can verify the `nonce` claim in the returned ID token matches what this
 * server actually issued, rather than trusting whatever nonce (if any) is embedded in an
 * unverified token. Kept independent of the policy store above so a lookup/consumption of
 * one never accidentally consumes or clobbers the other for the same `state` key.
 */
const nonceStore = new Map();

function pruneNonce() {
  const t = now();
  for (const [k, v] of nonceStore) {
    if (v.expiresAt <= t) nonceStore.delete(k);
  }
}

setInterval(pruneNonce, 60 * 1000).unref();

/**
 * @param {string} state
 * @param {string} nonce
 */
function rememberNonceForState(state, nonce) {
  if (!state || !nonce) return;
  nonceStore.set(String(state), {
    nonce: String(nonce),
    expiresAt: now() + TTL_MS,
  });
}

/**
 * @param {string} state
 * @returns {string|null} nonce, or null if unknown/expired
 */
function takeNonceForState(state) {
  if (state == null || String(state).trim() === "") return null;
  pruneNonce();
  const key = String(state);
  const row = nonceStore.get(key);
  if (!row) return null;
  nonceStore.delete(key);
  if (row.expiresAt <= now()) return null;
  return row.nonce;
}

function now() {
  return Date.now();
}

function prune() {
  const t = now();
  for (const [k, v] of store) {
    if (v.expiresAt <= t) store.delete(k);
  }
}

setInterval(prune, 60 * 1000).unref();

/**
 * @param {string} state
 * @param {string} policyName
 */
function rememberStatePolicy(state, policyName) {
  if (!state || !policyName) return;
  store.set(String(state), {
    policy: String(policyName).trim(),
    expiresAt: now() + TTL_MS,
  });
}

/**
 * @param {string} state
 * @returns {string|null} policy name, or null if unknown/expired
 */
function takePolicyForState(state) {
  if (state == null || String(state).trim() === "") return null;
  prune();
  const key = String(state);
  const row = store.get(key);
  if (!row) return null;
  store.delete(key);
  if (row.expiresAt <= now()) return null;
  return row.policy;
}

module.exports = {
  rememberStatePolicy,
  takePolicyForState,
  rememberNonceForState,
  takeNonceForState,
};
