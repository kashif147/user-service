/**
 * Directory-claim policy (Stage 5b): the switches and environment rules around Microsoft Entra
 * directory claims. No database access here (models/directoryClaim.model.js and
 * helpers/directoryClaimGate.js use it).
 *
 *  - ENTRA_CRM_MULTI_DIRECTORY (Stage 5a): exactly "true" enables multi-directory CRM sign-in. Only
 *    then are verified directory claims required (sign-in and connection activation).
 *  - DEV shared-directory exception: several organisations may claim the SAME directory only when
 *    ALL of these hold: DEPLOYMENT_ENV is exactly "dev", ENTRA_ALLOW_SHARED_DIRECTORY is exactly
 *    "true", the directory is listed in ENTRA_SHARED_DIRECTORY_ALLOWLIST (comma-separated GUIDs)
 *    and the claim's method is "dev-exception". NODE_ENV is never used to infer DEV.
 *  - Either override variable configured outside DEV is a configuration error: the service refuses
 *    to start (assertDirectoryClaimConfig) and the exception never applies at runtime.
 */

const ENTRA = "Entra ID (Azure AD)";
const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Microsoft personal accounts (MSA) sign in through this fixed directory; never claimable.
const CONSUMER_DIRECTORY_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

const MULTI_DIRECTORY_ENV = "ENTRA_CRM_MULTI_DIRECTORY";
const DEPLOYMENT_ENV = "DEPLOYMENT_ENV";
const ALLOW_SHARED_ENV = "ENTRA_ALLOW_SHARED_DIRECTORY";
const SHARED_ALLOWLIST_ENV = "ENTRA_SHARED_DIRECTORY_ALLOWLIST";

class DirectoryClaimConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "DirectoryClaimConfigError";
    this.code = "DIRECTORY_CLAIM_CONFIG";
  }
}

const isEntraMultiDirectoryEnabled = () => process.env[MULTI_DIRECTORY_ENV] === "true";

/** Lower-case, trimmed directory id when it is a claimable directory GUID; otherwise null. */
function normalizeDirectoryId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  if (!DIRECTORY_GUID.test(id) || id === CONSUMER_DIRECTORY_ID) return null;
  return id;
}

const isSet = (name) => typeof process.env[name] === "string" && process.env[name].trim() !== "";
const isDevDeployment = () => process.env[DEPLOYMENT_ENV] === "dev";
const sharedDirectoryOverrideConfigured = () => isSet(ALLOW_SHARED_ENV) || isSet(SHARED_ALLOWLIST_ENV);

/** Parsed allow-list; throws on any entry that is not a claimable directory GUID. */
function sharedDirectoryAllowlist() {
  if (!isSet(SHARED_ALLOWLIST_ENV)) return [];
  return process.env[SHARED_ALLOWLIST_ENV].split(",").map((entry) => {
    const id = normalizeDirectoryId(entry);
    if (!id) throw new DirectoryClaimConfigError(`${SHARED_ALLOWLIST_ENV} contains an invalid directory id`);
    return id;
  });
}

/** True only when every DEV shared-directory condition holds for this directory. Never throws. */
function devExceptionAllowed(directoryId) {
  const id = normalizeDirectoryId(directoryId);
  if (!id || !isDevDeployment() || process.env[ALLOW_SHARED_ENV] !== "true") return false;
  try {
    return sharedDirectoryAllowlist().includes(id);
  } catch {
    return false;
  }
}

/**
 * Startup check. Throws (the service must not start) when the shared-directory override is
 * configured outside DEV or its allow-list is malformed. Names only, never values.
 */
function assertDirectoryClaimConfig() {
  if (!sharedDirectoryOverrideConfigured()) return;
  if (!isDevDeployment()) {
    throw new DirectoryClaimConfigError(
      `${ALLOW_SHARED_ENV} / ${SHARED_ALLOWLIST_ENV} are allowed only when ${DEPLOYMENT_ENV}=dev; refusing to start`
    );
  }
  sharedDirectoryAllowlist();
}

module.exports = {
  ENTRA,
  DIRECTORY_GUID,
  CONSUMER_DIRECTORY_ID,
  DirectoryClaimConfigError,
  isEntraMultiDirectoryEnabled,
  normalizeDirectoryId,
  isDevDeployment,
  sharedDirectoryOverrideConfigured,
  sharedDirectoryAllowlist,
  devExceptionAllowed,
  assertDirectoryClaimConfig,
};
