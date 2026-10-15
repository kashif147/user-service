/**
 * Server-side configuration of the identity-provider APPLICATIONS (app registrations) this
 * deployment signs users in through. Environment-specific, never stored in MongoDB.
 *
 * Approved model: an authentication connection identifies the CUSTOMER DIRECTORY only
 * (connection.directoryId = Microsoft Directory (tenant) ID); the APPLICATION is fixed per use
 * case and is never chosen by tenant data:
 *  - entraCrm: the one shared ProjectShell CRM app registration (multi-tenant target). Every
 *    organisation signs in through the same Application (client) ID, credential and scopes; the
 *    customer is distinguished by directory (tid), never by client id, scope or audience.
 *  - legacySharedB2C: the shared ProjectShell Azure B2C directory and app (compatibility until
 *    member identity becomes per organisation).
 * A connection's stored `appRef` (Phase 3B) is inert legacy data and is never read here.
 *
 * Loaded application: { application, provider, label, clientId, redirectUris: {default},
 * redirectUri (= redirectUris.default), scopes, multiDirectory, ...provider settings } plus a
 * non-enumerable clientSecret. `secretRef` (WHERE the secret comes from) stays in this module.
 * Environment variables back the values today; certificate credentials from Key Vault are the
 * production target.
 *
 * Secrets: `clientSecret` is attached non-enumerable, so a loaded application (and anything built
 * from it) never carries it into JSON, logs or API responses by accident. Errors name missing
 * variables only, never values.
 */
const { getEntraConfig } = require("./entraConfig");

const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";

class AuthConfigError extends Error {
  constructor(code, message, missing = []) {
    super(message);
    this.name = "AuthConfigError";
    this.code = code;
    this.missing = missing;
  }
}

const read = (name) => {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

function withSecret(values, secret) {
  Object.defineProperty(values, "clientSecret", { value: secret, enumerable: false });
  return Object.freeze(values);
}

// Legacy shared Azure B2C (one ProjectShell-owned directory and app for every organisation). This
// is a compatibility arrangement, not the target: member identity is to become per organisation.
const B2C_ENV = {
  clientId: "MS_CLIENT_ID",
  redirectUri: "MS_REDIRECT_URI",
  tenantName: "MS_TENANT_NAME",
  directoryId: "MS_B2C_DIRECTORY_ID",
};

const ENTRA_CRM = {
  label: "ProjectShell CRM (Microsoft Entra ID)",
  // false: the registration signs in to its home directory only (Phase 3A compatibility assertion).
  multiDirectory: false,
  secretRef: { source: "env", name: "AZURE_AD_CLIENT_SECRET" },
};

const LEGACY_SHARED_B2C = {
  label: "ProjectShell member portal (shared Azure B2C, legacy)",
  multiDirectory: false,
  secretRef: null, // public client with PKCE
};

/**
 * The shared CRM application (Microsoft Entra ID).
 * @throws {import("./entraConfig").EntraConfigError} when its configuration is incomplete
 */
function getEntraCrmApp() {
  const c = getEntraConfig();
  return withSecret(
    {
      application: "entraCrm",
      provider: ENTRA,
      label: ENTRA_CRM.label,
      clientId: c.clientId,
      redirectUris: Object.freeze({ default: c.redirectUri }),
      redirectUri: c.redirectUri,
      scopes: "openid profile email offline_access",
      multiDirectory: ENTRA_CRM.multiDirectory,
      compatibilityDirectoryId: c.tenantId,
    },
    c.clientSecret
  );
}

/**
 * The shared (legacy) member-portal application and directory (Azure B2C).
 * @throws {AuthConfigError} B2C_NOT_CONFIGURED when its configuration is incomplete
 */
function getLegacySharedB2CApp() {
  const missing = Object.values(B2C_ENV).filter((name) => !read(name));
  if (missing.length) {
    throw new AuthConfigError(
      "B2C_NOT_CONFIGURED",
      `Azure B2C sign-in is not configured (missing ${missing.join(", ")})`,
      missing
    );
  }
  return withSecret(
    {
      application: "legacySharedB2C",
      provider: B2C,
      label: LEGACY_SHARED_B2C.label,
      clientId: read(B2C_ENV.clientId),
      redirectUris: Object.freeze({ default: read(B2C_ENV.redirectUri) }),
      redirectUri: read(B2C_ENV.redirectUri),
      scopes: "openid offline_access",
      multiDirectory: LEGACY_SHARED_B2C.multiDirectory,
      sharedDirectory: {
        // b2clogin.com host names are always lower case (see helpers/b2cPolicy.js).
        tenantName: read(B2C_ENV.tenantName).toLowerCase(),
        directoryId: read(B2C_ENV.directoryId),
      },
    },
    null
  );
}

module.exports = { ENTRA, B2C, AuthConfigError, getEntraCrmApp, getLegacySharedB2CApp };
