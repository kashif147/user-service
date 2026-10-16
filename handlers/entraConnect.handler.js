/**
 * "Connect Microsoft Entra" (Stage 5c-1): proves that the directory configured on an Entra
 * authentication connection belongs to its ProjectShell organisation, and records a verified
 * DirectoryClaim. Connect does not activate the connection, does not change its directory and does
 * not enable sign-in (the multi-directory switch and the claim gate decide that).
 *
 *  start    -> server loads the connection; refuses DEV shared-exception / already-claimed
 *              directories; binds {tenant, connection, directory snapshot, initiating user, nonce,
 *              PKCE verifier} to a single-use server-side state; returns the authorize URL.
 *  complete -> takes that state (caller, tenant and connection must match it), reloads the
 *              connection (unchanged directory), exchanges the code, verifies the ID token
 *              (helpers/entraConnect.js), requires tid == connection directory and a signed
 *              administrator role, records the claim, then sets connectedAt / connectedBy only.
 *  test     -> (Stage 5c-2) server loads the connection; requires its valid verified claim
 *              (DIRECTORY_NOT_CLAIMED otherwise, without calling Microsoft); checks the directory
 *              and the shared application with Microsoft (helpers/entraConnectionTest.js); records
 *              lastTestedAt / lastTestResult {ok, code} only. Never changes the claim, the
 *              directory, isActive, provisioning, users or roles. A disconnected connection is
 *              refused first (CONNECTION_DISCONNECTED): no Microsoft call, nothing written.
 *  disconnect -> (Stage 5c-3) server loads the connection; requires its verified
 *              entra-admin-sign-in claim (NOT_CONNECTED; platform-managed claims refused); then ONE
 *              transaction: connection isActive=false + disconnectedAt/By, claim revoked +
 *              revokedAt/By (same timestamp). Both or neither. Users, roles, the directory,
 *              provisioning, connect and test metadata are untouched; a reconnect creates a new claim.
 *
 * Everything that identifies the organisation, connection, directory or administrator comes from
 * the server-side state and the verified token - never from the request body or query. Tokens,
 * the code and the verifier are never stored or logged.
 */
const mongoose = require("mongoose");
const Tenant = require("../models/tenant.model");
const AzureADHandler = require("./azure.ad.handler");
const { resolveEntraConnectConfig } = require("../helpers/connectionAuthConfig");
const { rememberConnectTransaction, takeConnectTransaction, CONNECT_FLOW } = require("../helpers/pkceStateStore");
const {
  EntraConnectError,
  newConnectSecrets,
  buildConnectAuthorizeUrl,
  verifyConnectIdToken,
} = require("../helpers/entraConnect");
const {
  assertDirectoryConnectable,
  recordVerifiedConnectClaim,
  deriveConnectionStatus,
  findConnectionClaim,
  findValidConnectionClaim,
  isConnectionDisconnected,
  assertDisconnectable,
  revokeConnectionClaim,
} = require("../helpers/directoryClaimService");
const { ENTRA, normalizeDirectoryId } = require("../helpers/directoryClaimPolicy");
const { probeEntraDirectory, TEST_RESULT_CODES } = require("../helpers/entraConnectionTest");

const plain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v);

// Disconnect writes the connection and the claim in one MongoDB transaction (replica set).
async function defaultTransactionRunner(work) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      out = await work(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}
let runInTransaction = defaultTransactionRunner;
/** Test hook: replace the transaction runner (null restores the real one). */
function _setTransactionRunnerForTests(runner) {
  runInTransaction = runner || defaultTransactionRunner;
}

/** The organisation's Entra connection, loaded by the server. */
async function loadEntraConnection(tenantId, connectionId) {
  const tenant = await Tenant.findOne({ _id: String(tenantId), isActive: { $ne: false } })
    .select("_id authenticationConnections")
    .lean();
  if (!tenant) throw new EntraConnectError("CONNECTION_NOT_FOUND");
  const connection = (tenant.authenticationConnections || []).map(plain).find((c) => String(c._id) === String(connectionId));
  if (!connection) throw new EntraConnectError("CONNECTION_NOT_FOUND");
  if (connection.connectionType !== ENTRA) throw new EntraConnectError("NOT_ENTRA_CONNECTION");
  const directoryId = normalizeDirectoryId(connection.directoryId);
  if (!directoryId) throw new EntraConnectError("INVALID_DIRECTORY");
  return { tenantId: String(tenant._id), connection, directoryId };
}

async function startConnect({ tenantId, connectionId, userId }) {
  if (!userId) throw new EntraConnectError("CONNECT_STATE_INVALID");
  const loaded = await loadEntraConnection(tenantId, connectionId);
  await assertDirectoryConnectable({ tenantId: loaded.tenantId, connectionId, directoryId: loaded.directoryId });
  const config = resolveEntraConnectConfig();
  const secrets = newConnectSecrets();
  rememberConnectTransaction(secrets.state, {
    tenantId: loaded.tenantId,
    connectionId: String(connectionId),
    directoryId: loaded.directoryId,
    initiatingUserId: String(userId),
    nonce: secrets.nonce,
    codeVerifier: secrets.codeVerifier,
  });
  return { authorizationUrl: buildConnectAuthorizeUrl(config, secrets) };
}

/** Sets connectedAt / connectedBy only, and only while the connection still has that directory. */
async function markConnectionConnected({ tenantId, connectionId, directoryId, userId }) {
  const at = new Date();
  const result = await Tenant.updateOne(
    {
      _id: String(tenantId),
      authenticationConnections: { $elemMatch: { _id: String(connectionId), connectionType: ENTRA, directoryId } },
    },
    {
      $set: {
        "authenticationConnections.$.connectedAt": at,
        "authenticationConnections.$.connectedBy": String(userId),
      },
    }
  );
  if (!result || result.matchedCount !== 1) throw new EntraConnectError("CONNECTION_CHANGED");
  return at;
}

async function completeConnect({ tenantId, connectionId, userId, code, state }) {
  const tx = takeConnectTransaction(state);
  if (
    !tx ||
    tx.flow !== CONNECT_FLOW ||
    !userId ||
    tx.initiatingUserId !== String(userId) ||
    tx.tenantId !== String(tenantId) ||
    tx.connectionId !== String(connectionId)
  ) {
    throw new EntraConnectError("CONNECT_STATE_INVALID");
  }
  if (typeof code !== "string" || code.trim() === "") throw new EntraConnectError("CONNECT_STATE_INVALID");

  let loaded;
  try {
    loaded = await loadEntraConnection(tx.tenantId, tx.connectionId);
  } catch {
    throw new EntraConnectError("CONNECTION_CHANGED");
  }
  if (loaded.directoryId !== tx.directoryId) throw new EntraConnectError("CONNECTION_CHANGED");

  const config = resolveEntraConnectConfig();
  let idToken;
  try {
    const tokens = await AzureADHandler.exchangeCodeForTokens(code, tx.codeVerifier, config);
    idToken = tokens && tokens.id_token; // only the ID token is used; nothing is kept
  } catch {
    throw new EntraConnectError("TOKEN_EXCHANGE_FAILED");
  }
  const verified = await verifyConnectIdToken(idToken, tx.nonce, config, { stateCreatedAt: tx.createdAt });
  idToken = null;
  if (verified.directoryId !== loaded.directoryId) throw new EntraConnectError("DIRECTORY_MISMATCH");

  const claim = await recordVerifiedConnectClaim({
    tenantId: tx.tenantId,
    connectionId: tx.connectionId,
    directoryId: verified.directoryId,
    userId: tx.initiatingUserId,
    evidence: { directoryUserId: verified.directoryUserId, roleTemplateId: verified.roleTemplateId },
  });
  const connectedAt = await markConnectionConnected({
    tenantId: tx.tenantId,
    connectionId: tx.connectionId,
    directoryId: loaded.connection.directoryId, // as stored (already proven equal to the verified tid)
    userId: tx.initiatingUserId,
  });
  console.info("Entra directory connected:", {
    tenantId: tx.tenantId,
    connectionId: tx.connectionId,
    directoryId: verified.directoryId,
    claimId: claim.claimId,
    created: claim.created,
  });
  return { status: "connected", directoryId: verified.directoryId, connectedAt, connectedBy: tx.initiatingUserId };
}

/**
 * Sets lastTestedAt / lastTestResult {ok, code} only, and only while the connection still has
 * that directory (CONNECTION_CHANGED otherwise: a result is never written to a changed connection).
 */
async function recordConnectionTestResult({ tenantId, connectionId, directoryId, result }) {
  if (!result || !TEST_RESULT_CODES.includes(result.code)) throw new EntraConnectError("TEST_RESULT_INVALID");
  const at = new Date();
  const outcome = await Tenant.updateOne(
    {
      _id: String(tenantId),
      authenticationConnections: { $elemMatch: { _id: String(connectionId), connectionType: ENTRA, directoryId } },
    },
    {
      $set: {
        "authenticationConnections.$.lastTestedAt": at,
        "authenticationConnections.$.lastTestResult": { ok: result.ok === true, code: result.code },
      },
    }
  );
  if (!outcome || outcome.matchedCount !== 1) throw new EntraConnectError("CONNECTION_CHANGED");
  return at;
}

async function testConnection({ tenantId, connectionId }) {
  const loaded = await loadEntraConnection(tenantId, connectionId);
  const claim = await findValidConnectionClaim({ tenantId: loaded.tenantId, connectionId, directoryId: loaded.directoryId });
  if (!claim && (await isConnectionDisconnected({ tenantId: loaded.tenantId, connectionId, directoryId: loaded.directoryId }))) {
    throw new EntraConnectError("CONNECTION_DISCONNECTED");
  }
  const result = claim
    ? await probeEntraDirectory(loaded.directoryId)
    : { ok: false, code: "DIRECTORY_NOT_CLAIMED", step: "claim", httpStatus: null };
  const testedAt = await recordConnectionTestResult({
    tenantId: loaded.tenantId,
    connectionId,
    directoryId: loaded.connection.directoryId, // as stored
    result,
  });
  // Safe fields only: never a token, credential or anything Microsoft returned beyond its HTTP status.
  console.info("Entra connection tested:", {
    tenantId: loaded.tenantId,
    connectionId: String(connectionId),
    ok: result.ok,
    code: result.code,
    step: result.step,
    httpStatus: result.httpStatus,
  });
  return { ok: result.ok, code: result.code, testedAt };
}

/**
 * Disconnect Microsoft Entra (Stage 5c-3). Organisation, connection and directory come from the
 * server-loaded connection; the actor is the authenticated ProjectShell user.
 */
async function disconnectConnection({ tenantId, connectionId, userId }) {
  if (!userId) throw new EntraConnectError("ACTOR_REQUIRED");
  const loaded = await loadEntraConnection(tenantId, connectionId);
  await assertDisconnectable({ tenantId: loaded.tenantId, connectionId, directoryId: loaded.directoryId });
  const at = new Date(); // one timestamp for the whole operation (disconnectedAt == revokedAt)
  const actor = String(userId);
  await runInTransaction(async (session) => {
    const outcome = await Tenant.updateOne(
      {
        _id: loaded.tenantId,
        authenticationConnections: {
          $elemMatch: { _id: String(connectionId), connectionType: ENTRA, directoryId: loaded.connection.directoryId },
        },
      },
      {
        $set: {
          "authenticationConnections.$.isActive": false,
          "authenticationConnections.$.disconnectedAt": at,
          "authenticationConnections.$.disconnectedBy": actor,
        },
      },
      { session }
    );
    if (!outcome || outcome.matchedCount !== 1) throw new EntraConnectError("CONNECTION_CHANGED");
    await revokeConnectionClaim({ session, tenantId: loaded.tenantId, connectionId, directoryId: loaded.directoryId, userId: actor, at });
  });
  console.info("Entra connection disconnected:", { tenantId: loaded.tenantId, connectionId: String(connectionId), directoryId: loaded.directoryId });
  return { status: "disconnected", directoryId: loaded.directoryId, disconnectedAt: at, disconnectedBy: actor };
}

async function getConnectionStatus({ tenantId, connectionId }) {
  const loaded = await loadEntraConnection(tenantId, connectionId);
  const claim = await findConnectionClaim(connectionId);
  const { status, sharedDirectoryException } = deriveConnectionStatus(loaded.connection, claim, loaded.tenantId);
  const c = loaded.connection;
  const out = {
    status,
    directoryId: loaded.directoryId,
    connectedAt: c.connectedAt ?? null,
    connectedBy: c.connectedBy ?? null,
    autoProvisionUsers: c.autoProvisionUsers === true,
    isActive: c.isActive === true,
    sharedDirectoryException,
  };
  if (c.lastTestedAt) out.lastTestedAt = c.lastTestedAt;
  if (c.disconnectedAt) out.disconnectedAt = c.disconnectedAt;
  if (c.disconnectedBy) out.disconnectedBy = c.disconnectedBy;
  if (c.lastTestResult) out.lastTestResult = { ok: c.lastTestResult.ok === true, code: c.lastTestResult.code ?? null };
  return out;
}

module.exports = {
  startConnect,
  completeConnect,
  testConnection,
  recordConnectionTestResult,
  disconnectConnection,
  _setTransactionRunnerForTests,
  getConnectionStatus,
  markConnectionConnected,
  loadEntraConnection,
};
