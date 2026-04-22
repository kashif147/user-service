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
};
