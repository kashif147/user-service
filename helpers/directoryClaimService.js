/**
 * Directory-claim writes for "Connect Microsoft Entra" (Stage 5c) and the derived connection
 * status. Ownership is never transferred: the partial unique index on verified normal claims is
 * the final guard against two organisations verifying the same directory concurrently.
 *
 * Upsert rules (connectionType Entra, the state-bound organisation + connection, the verified tid):
 *  - no claim for the connection           -> create a verified entra-admin-sign-in claim
 *  - own pending entra-admin-sign-in claim -> upgrade to verified
 *  - own verified entra-admin-sign-in claim (same directory) -> refresh verifiedAt / verifiedBy /
 *    verificationEvidence (reconnect)
 *  - any DEV shared-directory exception for the directory -> DIRECTORY_SHARED_EXCEPTION, unchanged
 *  - a verified claim of another organisation/connection   -> DIRECTORY_ALREADY_CLAIMED
 *  - own claim for another directory, or another method    -> DIRECTORY_MISMATCH / CLAIM_METHOD_CONFLICT
 *
 * The model is required lazily so ordinary sign-in never loads it (Stage 5b property).
 */
const { ENTRA, normalizeDirectoryId } = require("./directoryClaimPolicy");
const { claimStillValid } = require("./directoryClaimGate");
const { EntraConnectError } = require("./entraConnect");

const ADMIN_SIGN_IN = "entra-admin-sign-in";
const model = () => require("../models/directoryClaim.model");

/** Refuses a directory that is a DEV shared exception or verified for another connection. */
async function assertDirectoryConnectable({ tenantId, connectionId, directoryId }) {
  const dir = normalizeDirectoryId(directoryId);
  if (!dir) throw new EntraConnectError("INVALID_DIRECTORY");
  const claims = await model().find({ connectionType: ENTRA, directoryId: dir }).lean();
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

  const own = await DirectoryClaim.findOne({ connectionType: ENTRA, connectionId: String(connectionId) });
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
 * Derived status of one connection (nothing stored). A valid verified claim is "connected";
 * a failed test result (Stage 5c-2) turns it into "test_failed".
 */
function deriveConnectionStatus(connection, claim, tenantId) {
  const sharedDirectoryException = claim?.sharedDirectoryException === true;
  if (!claim || claim.status !== "verified") return { status: "not_connected", sharedDirectoryException: false };
  const dir = normalizeDirectoryId(connection?.directoryId);
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

/** The claim of one connection (lean) or null. */
async function findConnectionClaim(connectionId) {
  return model().findOne({ connectionType: ENTRA, connectionId: String(connectionId) }).lean();
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
};
