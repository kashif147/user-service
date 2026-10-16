/**
 * Directory-claim gate (Stage 5b). In multi-directory mode (ENTRA_CRM_MULTI_DIRECTORY exactly
 * "true") an Entra connection may be used - for sign-in, or activated by a connection write - only
 * when a VERIFIED DirectoryClaim matches its directory, its organisation AND the connection itself.
 * Anything else fails closed with DIRECTORY_NOT_CLAIMED.
 *
 * With the switch off this is a no-op (no database read): single-directory compatibility mode
 * already limits sign-in to the CRM app's home directory (helpers/connectionAuthConfig.js).
 *
 * Enforced at: login start (controllers/pkce.controller.js), the callback after the connection is
 * reloaded from the state (handlers/azure.ad.handler.js resolveAuthConfig), and every connection
 * write that activates or changes an Entra connection (helpers/connectionDefaultRole.js).
 */
const { AuthConfigError } = require("./authAppRegistry");
const { ENTRA, isEntraMultiDirectoryEnabled, normalizeDirectoryId, devExceptionAllowed } = require("./directoryClaimPolicy");

const NORMAL_METHODS = new Set(["entra-admin-sign-in", "platform"]);
const DEV_EXCEPTION_METHOD = "dev-exception";

const notClaimed = () =>
  new AuthConfigError("DIRECTORY_NOT_CLAIMED", "Authentication connection directory is not verified for this organisation");

/** True when the stored claim is verified and still valid under the current policy. */
function claimStillValid(claim, directoryId) {
  if (!claim || claim.status !== "verified" || !claim.verifiedAt) return false;
  const isException = claim.method === DEV_EXCEPTION_METHOD;
  if (claim.sharedDirectoryException !== isException) return false;
  return isException ? devExceptionAllowed(directoryId) : NORMAL_METHODS.has(claim.method);
}

/**
 * @param {{tenantId: string, connection: object, connectionId?: string}} args  connectionId
 *   defaults to connection._id
 * @returns {Promise<{required: boolean, claimId?: string}>}
 * @throws {AuthConfigError} DIRECTORY_NOT_CLAIMED
 */
async function assertConnectionDirectoryClaim({ tenantId, connection, connectionId }) {
  if (!isEntraMultiDirectoryEnabled()) return { required: false };
  if (!connection || connection.connectionType !== ENTRA) return { required: false };
  const directoryId = normalizeDirectoryId(connection.directoryId);
  const id = connectionId ?? connection._id;
  if (!directoryId || !tenantId || id === undefined || id === null || id === "") throw notClaimed();

  // Required lazily: the model is only touched in multi-directory mode.
  const DirectoryClaim = require("../models/directoryClaim.model");
  const claim = await DirectoryClaim.findOne({
    connectionType: ENTRA,
    directoryId,
    tenantId: String(tenantId),
    connectionId: String(id),
    status: "verified",
  }).lean();
  if (!claimStillValid(claim, directoryId)) throw notClaimed();
  return { required: true, claimId: String(claim._id) };
}

module.exports = { assertConnectionDirectoryClaim, claimStillValid };
