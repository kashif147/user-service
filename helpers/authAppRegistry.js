/**
 * Server-side registry of the identity-provider APPLICATIONS (app registrations) this deployment
 * signs users in through.
 *
 * An authentication connection (models/tenant.model.js) says which provider and directory an
 * organisation uses. The application it signs in through (client id, redirect URI, scopes, client
 * secret) is ProjectShell's own configuration and lives here, never in MongoDB. A connection names
 * its application by `appRef`; until connections store one, each provider has a default entry
 * (DEFAULT_APP_REF). Client ids come only from here - not from a connection - so there is one
 * source of truth.
 *
 * Phase 3A: the entries read the current environment variables. Later entries can describe
 * customer-specific registrations (e.g. one portal/mobile app per organisation) or resolve the
 * secret from a Key Vault reference, without changing the sign-in flows, which only ever see the
 * resolved values (helpers/connectionAuthConfig.js).
 *
 * Secrets: `clientSecret` is attached non-enumerable, so a resolved application (and anything
 * built from it) never carries it into JSON, logs or API responses by accident. Errors name
 * missing variables only, never values.
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

const APPS = {
  // CRM sign-in (Microsoft Entra ID). The app registration is single-directory today: its home
  // directory is the only one sign-in may use (compatibilityDirectoryId, see connectionAuthConfig).
  "crm-entra": {
    provider: ENTRA,
    load() {
      const c = getEntraConfig(); // EntraConfigError (variable names only) when incomplete
      return withSecret(
        {
          appRef: "crm-entra",
          provider: ENTRA,
          clientId: c.clientId,
          redirectUri: c.redirectUri,
          scopes: "openid profile email offline_access",
          compatibilityDirectoryId: c.tenantId,
        },
        c.clientSecret
      );
    },
  },
  // Member portal sign-in (legacy shared Azure B2C). Public client with PKCE: no client secret.
  "portal-b2c": {
    provider: B2C,
    load() {
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
          appRef: "portal-b2c",
          provider: B2C,
          clientId: read(B2C_ENV.clientId),
          redirectUri: read(B2C_ENV.redirectUri),
          scopes: "openid offline_access",
          sharedDirectory: {
            // b2clogin.com host names are always lower case (see helpers/b2cPolicy.js).
            tenantName: read(B2C_ENV.tenantName).toLowerCase(),
            directoryId: read(B2C_ENV.directoryId),
          },
        },
        null
      );
    },
  },
};

const DEFAULT_APP_REF = { [ENTRA]: "crm-entra", [B2C]: "portal-b2c" };

/**
 * The application `appRef` of a connection of `provider` (connectionType). Unknown references,
 * or an application of another provider, fail closed.
 * @throws {AuthConfigError|EntraConfigError}
 */
function getAuthApp(appRef, provider) {
  const entry = Object.prototype.hasOwnProperty.call(APPS, appRef) ? APPS[appRef] : null;
  if (!entry || entry.provider !== provider) {
    throw new AuthConfigError("UNKNOWN_APP_REF", "Authentication application is not configured");
  }
  return entry.load();
}

module.exports = { ENTRA, B2C, AuthConfigError, DEFAULT_APP_REF, getAuthApp };
