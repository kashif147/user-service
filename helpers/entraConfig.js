// Microsoft Entra ID (CRM sign-in) configuration, read from the environment at call time.
//
// There are deliberately no built-in fallback values: a missing directory id, client id, client
// secret or redirect URI must stop Entra sign-in with a clear error, never silently point the
// login at a hard-coded directory or app registration.

const REQUIRED = {
  tenantId: "AZURE_AD_TENANT_ID",
  clientId: "AZURE_AD_CLIENT_ID",
  clientSecret: "AZURE_AD_CLIENT_SECRET",
  redirectUri: "AZURE_AD_REDIRECT_URI",
};

class EntraConfigError extends Error {
  constructor(missing) {
    super(`Microsoft Entra sign-in is not configured (missing ${missing.join(", ")})`);
    this.name = "EntraConfigError";
    this.code = "ENTRA_NOT_CONFIGURED";
    this.missing = missing;
  }
}

const read = (name) => {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

/** @returns {string[]} names of the required variables that are missing or empty */
function missingEntraConfig() {
  return Object.values(REQUIRED).filter((name) => !read(name));
}

/**
 * @returns {{tenantId: string, clientId: string, clientSecret: string, redirectUri: string}}
 * @throws {EntraConfigError} when any required variable is missing or empty
 */
function getEntraConfig() {
  const missing = missingEntraConfig();
  if (missing.length) throw new EntraConfigError(missing);
  return Object.fromEntries(Object.entries(REQUIRED).map(([key, name]) => [key, read(name)]));
}

/** Startup check: logs (names only, never values) which Entra variables are missing. */
function logMissingEntraConfig() {
  const missing = missingEntraConfig();
  if (missing.length) {
    console.error(`Microsoft Entra sign-in is disabled until configured: missing ${missing.join(", ")}`);
  }
  return missing;
}

module.exports = { getEntraConfig, missingEntraConfig, logMissingEntraConfig, EntraConfigError };
