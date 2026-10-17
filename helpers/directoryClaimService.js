/**
 * Directory-claim writes for "Connect Microsoft Entra" (Stage 5c) and the derived connection
 * status. Ownership is never transferred: the partial unique index on verified normal claims is
 * the final guard against two organisations verifying the same directory concurrently.
 *
 * Upsert rules (connectionType Entra, the state-bound organisation + connection, the verified tid).
 * Only ACTIVE claims (pending / verified) count; revoked claims are audit history (Stage 5c-3):
 *  - no active claim for the connection    -> create a NEW verified entra-admin-sign-in claim
 *    (also after a Disconnect: the revoked claim is never reopened)
 *  - own pending entra-admin-sign-in claim -> upgrade to verified
 *  - own verified entra-admin-sign-in claim (same directory) -> refresh verifiedAt / verifiedBy /
 *    verificationEvidence (reconnect)
 *  - any DEV shared-directory exception for the directory -> DIRECTORY_SHARED_EXCEPTION, unchanged
 *  - a verified claim of another organisation/connection   -> DIRECTORY_ALREADY_CLAIMED
 *  - own claim for another directory, or another method    -> DIRECTORY_MISMATCH / CLAIM_METHOD_CONFLICT
 *
 * Disconnect (Stage 5c-3) revokes the connection's verified entra-admin-sign-in claim inside the
 * caller's transaction (revokeConnectionClaim); platform-managed claims (dev-exception, platform)
 * are never revoked by a tenant administrator.
 *
 * The model is required lazily so ordinary sign-in never loads it (Stage 5b property).
 */
const { ENTRA, normalizeDirectoryId } = require("./directoryClaimPolicy");
const { claimStillValid } = require("./directoryClaimGate");
const { EntraConnectError } = require("./entraConnect");

const ADMIN_SIGN_IN = "entra-admin-sign-in";
const ACTIVE = ["pending", "verified"];
const model = () => require("../models/directoryClaim.model");
const isActiveClaim = (c) => !!c && ACTIVE.includes(c.status);
const time = (v) => (v ? new Date(v).getTime() : 0);
/** Deterministic pick among a connection's claims: the active claim, else the latest revoked one. */
function pickConnectionClaim(claims) {
  const active = claims.filter(isActiveClaim).sort((a, b) => String(a._id).localeCompare(String(b._id)));
  if (active.length) return active[0];
  const revoked = claims
    .filter((c) => c.status === "revoked")
    .sort((a, b) => time(b.revokedAt) - time(a.revokedAt) || String(b._id).localeCompare(String(a._id)));
  return revoked[0] || null;
}

/** Refuses a directory that is a DEV shared exception or verified for another connection. */
async function assertDirectoryConnectable({ tenantId, connectionId, directoryId }) {
  const dir = normalizeDirectoryId(directoryId);
  if (!dir) throw new EntraConnectError("INVALID_DIRECTORY");
  const claims = (await model().find({ connectionType: ENTRA, directoryId: dir }).lean()).filter(isActiveClaim);
  if (claims.some((c) => c.sharedDirectoryException === true || c.method === "dev-exception")) {
    throw new EntraConnectError("DIRECTORY_SHARED_EXCEPTION");
  }
  const otherVerified = claims.some(
    (c) => c.status === "verified" && (String(c.tenantId) !== String(tenantId) || String(c.connectionId) !== String(connectionId))
  );
  if (otherVerified) throw new EntraConnectError("DIRECTORY_ALREADY_CLAIMED");
  return dir;
}

const isDuplicate = (e) => e && (e.code === 11000 || e.code === "DIRECTORY_ALREADY_CLAIMED");

/**
 * @param {{tenantId: string, connectionId: string, directoryId: string, userId: string,
 *   evidence: {directoryUserId: string, roleTemplateId: string}}} args  all server-derived
 * @returns {Promise<{claimId: string, created: boolean}>}
 */
async function recordVerifiedConnectClaim({ tenantId, connectionId, directoryId, userId, evidence }) {
  const DirectoryClaim = model();
  await DirectoryClaim.init(); // indexes exist before any write
  const dir = await assertDirectoryConnectable({ tenantId, connectionId, directoryId });
  const actor = `user:${userId}`;
  const now = new Date();
  const verificationEvidence = { directoryUserId: evidence.directoryUserId, roleTemplateId: evidence.roleTemplateId };

  const own = await DirectoryClaim.findOne({ connectionType: ENTRA, connectionId: String(connectionId), status: { $in: ACTIVE } });
  try {
    if (!own) {
      const created = await DirectoryClaim.create({
        connectionType: ENTRA,
        directoryId: dir,
        tenantId: String(tenantId),
        connectionId: String(connectionId),
        status: "verified",
        method: ADMIN_SIGN_IN,
        claimedAt: now,
        claimedBy: actor,
        verifiedAt: now,
        verifiedBy: actor,
        verificationEvidence,
      });
      return { claimId: String(created._id), created: true };
    }
    if (own.method === "dev-exception" || own.sharedDirectoryException) throw new EntraConnectError("DIRECTORY_SHARED_EXCEPTION");
    if (String(own.tenantId) !== String(tenantId)) throw new EntraConnectError("DIRECTORY_ALREADY_CLAIMED");
    if (own.directoryId !== dir) throw new EntraConnectError("DIRECTORY_MISMATCH");
    if (own.method !== ADMIN_SIGN_IN) throw new EntraConnectError("CLAIM_METHOD_CONFLICT");
    own.status = "verified";
    own.verifiedAt = now;
    own.verifiedBy = actor;
    own.verificationEvidence = verificationEvidence;
    await own.save();
    return { claimId: String(own._id), created: false };
  } catch (e) {
    if (e instanceof EntraConnectError) throw e;
    if (isDuplicate(e)) throw new EntraConnectError("DIRECTORY_ALREADY_CLAIMED");
    throw e;
  }
}

/**
 * Derived status of one connection (nothing stored), from the claim picked by findConnectionClaim.
 * A valid verified claim is "connected"; a failed test result (Stage 5c-2) turns it into
 * "test_failed". Without an active claim, a revoked claim for the connection's CURRENT directory is
 * "disconnected" (Stage 5c-3); a revoked claim for another directory is "not_connected".
 */
function deriveConnectionStatus(connection, claim, tenantId) {
  const sharedDirectoryException = claim?.sharedDirectoryException === true;
  const dir = normalizeDirectoryId(connection?.directoryId);
  if (claim && claim.status === "revoked") {
    return claim.directoryId === dir ? { status: "disconnected", sharedDirectoryException } : { status: "not_connected", sharedDirectoryException: false };
  }
  if (!claim || claim.status !== "verified") return { status: "not_connected", sharedDirectoryException: false };
  const matches =
    !!dir &&
    claim.directoryId === dir &&
    String(claim.connectionId) === String(connection._id) &&
    String(claim.tenantId) === String(tenantId) &&
    claim.connectionType === ENTRA;
  if (!matches || !claimStillValid(claim, dir)) return { status: "reconnect_required", sharedDirectoryException };
  if (connection.lastTestResult && connection.lastTestResult.ok === false) {
    return { status: "test_failed", sharedDirectoryException };
  }
  return { status: "connected", sharedDirectoryException };
}

/** The claim that describes one connection (lean) or null: its active claim, else its latest revoked claim. */
async function findConnectionClaim(connectionId) {
  return pickConnectionClaim(await model().find({ connectionType: ENTRA, connectionId: String(connectionId) }).lean());
}

/**
 * True when the connection was disconnected and not reconnected since: no active claim for it, and a
 * revoked claim for its current directory. Read only.
 */
async function isConnectionDisconnected({ tenantId, connectionId, directoryId }) {
  const dir = normalizeDirectoryId(directoryId);
  if (!dir || !tenantId || connectionId === undefined || connectionId === null || connectionId === "") return false;
  const claims = await model()
    .find({ connectionType: ENTRA, tenantId: String(tenantId), connectionId: String(connectionId) })
    .lean();
  if (claims.some(isActiveClaim)) return false;
  return claims.some((c) => c.status === "revoked" && c.directoryId === dir);
}

/**
 * Activation guard (Stage 5c-3), keyed on the DURABLE claim history of the DIRECTORY - not on the
 * connection record (which may have been deleted and replaced) and not on the organisation (a released
 * directory's next owner may be another organisation). In order:
 *  1. the connection being activated has its own verified claim (this organisation + connection +
 *     directory) -> not blocked;
 *  2. otherwise any organisation's revoked NORMAL claim (entra-admin-sign-in, not a shared-directory
 *     exception) for the directory -> blocked until Connect;
 *  3. otherwise not blocked (existing behaviour).
 * One read of the directory's claims; only booleans leave this function. Read only.
 */
async function isActivationBlockedByDisconnect({ tenantId, connectionId, directoryId }) {
  const dir = normalizeDirectoryId(directoryId);
  if (!dir || !tenantId) return false;
  const claims = await model().find({ connectionType: ENTRA, directoryId: dir }).lean();
  const hasConnection = connectionId !== undefined && connectionId !== null && connectionId !== "";
  const ownVerified = claims.some(
    (c) => c.status === "verified" && String(c.tenantId) === String(tenantId) && hasConnection && String(c.connectionId) === String(connectionId)
  );
  if (ownVerified) return false;
  return claims.some((c) => c.status === "revoked" && c.method === ADMIN_SIGN_IN && c.sharedDirectoryException !== true);
}

/**
 * Disconnect precondition (read only): the connection's verified claim for its directory, which
 * must be an entra-admin-sign-in claim. NOT_CONNECTED / DIRECTORY_SHARED_EXCEPTION /
 * CLAIM_METHOD_CONFLICT otherwise.
 */
async function assertDisconnectable({ tenantId, connectionId, directoryId }) {
  const claim = await model()
    .findOne({ connectionType: ENTRA, tenantId: String(tenantId), connectionId: String(connectionId), directoryId, status: "verified" })
    .lean();
  if (!claim) throw new EntraConnectError("NOT_CONNECTED");
  if (claim.method === "dev-exception" || claim.sharedDirectoryException === true) throw new EntraConnectError("DIRECTORY_SHARED_EXCEPTION");
  if (claim.method !== ADMIN_SIGN_IN) throw new EntraConnectError("CLAIM_METHOD_CONFLICT");
  return claim;
}

/**
 * Revokes the connection's verified entra-admin-sign-in claim inside `session` (model validation
 * runs). CONNECTION_CHANGED when that claim is no longer there; the method rules are re-checked.
 */
async function revokeConnectionClaim({ session, tenantId, connectionId, directoryId, userId, at }) {
  const claim = await model().findOne(
    { connectionType: ENTRA, tenantId: String(tenantId), connectionId: String(connectionId), directoryId, status: "verified" },
    null,
    { session }
  );
  if (!claim) throw new EntraConnectError("CONNECTION_CHANGED");
  if (claim.method === "dev-exception" || claim.sharedDirectoryException === true) throw new EntraConnectError("DIRECTORY_SHARED_EXCEPTION");
  if (claim.method !== ADMIN_SIGN_IN) throw new EntraConnectError("CLAIM_METHOD_CONFLICT");
  claim.status = "revoked";
  claim.revokedAt = at;
  claim.revokedBy = `user:${userId}`;
  await claim.save({ session });
  return String(claim._id);
}

/**
 * The connection's verified claim when it matches the organisation, the connection and the
 * directory and is still valid under the current policy (a DEV exception only while every DEV
 * condition holds); otherwise null. Read only.
 */
async function findValidConnectionClaim({ tenantId, connectionId, directoryId }) {
  const dir = normalizeDirectoryId(directoryId);
  if (!dir || !tenantId || !connectionId) return null;
  const claim = await model()
    .findOne({ connectionType: ENTRA, directoryId: dir, tenantId: String(tenantId), connectionId: String(connectionId), status: "verified" })
    .lean();
  return claimStillValid(claim, dir) ? claim : null;
}

module.exports = {
  assertDirectoryConnectable,
  recordVerifiedConnectClaim,
  deriveConnectionStatus,
  findConnectionClaim,
  findValidConnectionClaim,
  isConnectionDisconnected,
  isActivationBlockedByDisconnect,
  assertDisconnectable,
  revokeConnectionClaim,
  pickConnectionClaim,
};
