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
 * @param {{tenantId: string, connectionId: string}|null} [loginContext] - the ProjectShell
 *   tenant (and its Entra connection) the sign-in was started for. Kept server-side next to the
 *   nonce so the callback restores it from the state alone; nothing the browser sends on the
 *   callback can change it.
 */
function rememberNonceForState(state, nonce, loginContext = null) {
  if (!state || !nonce) return;
  nonceStore.set(String(state), {
    nonce: String(nonce),
    loginContext: loginContext
      ? { tenantId: String(loginContext.tenantId), connectionId: String(loginContext.connectionId) }
      : null,
    expiresAt: now() + TTL_MS,
  });
}

/**
 * Single-use read of everything bound to an authorize `state`.
 * @param {string} state
 * @returns {{nonce: string, loginContext: {tenantId: string, connectionId: string}|null}|null}
 */
function takeLoginTransaction(state) {
  if (state == null || String(state).trim() === "") return null;
  pruneNonce();
  const key = String(state);
  const row = nonceStore.get(key);
  if (!row) return null;
  nonceStore.delete(key);
  if (row.expiresAt <= now()) return null;
  return { nonce: row.nonce, loginContext: row.loginContext || null };
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

/**
 * Stage 5c "Connect Microsoft Entra" transactions: a third, separate map, so a connect state can
 * never be consumed by a sign-in callback (takeLoginTransaction / takeNonceForState) and a sign-in
 * state never by a connect completion. Server-side only; single use; same 10-minute expiry.
 * Holds the PKCE verifier (never sent to the browser) and no tokens.
 */
const CONNECT_FLOW = "entra-connect";
const connectStore = new Map();

function pruneConnect() {
  const t = now();
  for (const [k, v] of connectStore) {
    if (v.expiresAt <= t) connectStore.delete(k);
  }
}

setInterval(pruneConnect, 60 * 1000).unref();

/**
 * @param {string} state  random, unguessable authorize state
 * @param {{tenantId: string, connectionId: string, directoryId: string, initiatingUserId: string,
 *   nonce: string, codeVerifier: string}} tx
 */
function rememberConnectTransaction(state, tx) {
  if (!state || !tx) return;
  connectStore.set(String(state), {
    flow: CONNECT_FLOW,
    tenantId: String(tx.tenantId),
    connectionId: String(tx.connectionId),
    directoryId: String(tx.directoryId),
    initiatingUserId: String(tx.initiatingUserId),
    nonce: String(tx.nonce),
    codeVerifier: String(tx.codeVerifier),
    createdAt: now(),
    expiresAt: now() + TTL_MS,
  });
}

/**
 * Single-use read of a connect transaction (deleted on read, also when expired).
 * @returns {null|{flow: string, tenantId: string, connectionId: string, directoryId: string,
 *   initiatingUserId: string, nonce: string, codeVerifier: string, createdAt: number}}
 */
function takeConnectTransaction(state) {
  if (state == null || String(state).trim() === "") return null;
  pruneConnect();
  const key = String(state);
  const row = connectStore.get(key);
  if (!row) return null;
  connectStore.delete(key);
  if (row.expiresAt <= now()) return null;
  const { expiresAt, ...tx } = row;
  return tx;
}

module.exports = {
  rememberStatePolicy,
  takePolicyForState,
  rememberNonceForState,
  takeNonceForState,
  takeLoginTransaction,
  CONNECT_FLOW,
  rememberConnectTransaction,
  takeConnectTransaction,
};
