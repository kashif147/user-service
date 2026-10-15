/**
 * Server-side registry of the identity-provider APPLICATIONS (app registrations) this deployment
 * signs users in through.
 *
 * An authentication connection (models/tenant.model.js) says which provider and directory an
 * organisation uses. The application it signs in through (client id, redirect URIs, scopes, client
 * secret) is ProjectShell's own configuration and lives here, never in MongoDB. A connection names
 * its application by an optional `appRef`; a connection without one uses its provider's
 * compatibility default (DEFAULT_APP_REF). Client ids come only from here - not from a connection -
 * so there is one source of truth.
 *
 * Entry (static definition): { provider, label, multiDirectory, scopes, env: {...}, secretRef }.
 * `secretRef` describes WHERE the secret comes from ({source: "env", name}); it is used only to
 * load the secret and never leaves this module. Loaded application: { appRef, provider, label,
 * clientId, redirectUris: {default}, redirectUri (= redirectUris.default), scopes, multiDirectory,
 * ...provider settings } plus a non-enumerable clientSecret.
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
    label: "ProjectShell CRM (Microsoft Entra ID)",
    // false: the registration signs in to its home directory only (Phase 3A compatibility assertion).
    multiDirectory: false,
    secretRef: { source: "env", name: "AZURE_AD_CLIENT_SECRET" },
    load() {
      const c = getEntraConfig(); // EntraConfigError (variable names only) when incomplete
      return withSecret(
        {
          appRef: "crm-entra",
          provider: ENTRA,
          label: this.label,
          clientId: c.clientId,
          redirectUris: Object.freeze({ default: c.redirectUri }),
          redirectUri: c.redirectUri,
          scopes: "openid profile email offline_access",
          multiDirectory: this.multiDirectory,
          compatibilityDirectoryId: c.tenantId,
        },
        c.clientSecret
      );
    },
  },
  // Member portal sign-in (legacy shared Azure B2C). Public client with PKCE: no client secret.
  "portal-b2c": {
    provider: B2C,
    label: "ProjectShell member portal (shared Azure B2C, legacy)",
    multiDirectory: false,
    secretRef: null,
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
          label: this.label,
          clientId: read(B2C_ENV.clientId),
          redirectUris: Object.freeze({ default: read(B2C_ENV.redirectUri) }),
          redirectUri: read(B2C_ENV.redirectUri),
          scopes: "openid offline_access",
          multiDirectory: this.multiDirectory,
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

// Compatibility defaults for connections that do not name an application.
const DEFAULT_APP_REF = Object.freeze({ [ENTRA]: "crm-entra", [B2C]: "portal-b2c" });

const entryOf = (appRef) =>
  typeof appRef === "string" && Object.prototype.hasOwnProperty.call(APPS, appRef) ? APPS[appRef] : null;

/**
 * The application `appRef` of a connection of `provider` (connectionType). Unknown references,
 * or an application of another provider, fail closed.
 * @throws {AuthConfigError|EntraConfigError}
 */
function getAuthApp(appRef, provider) {
  const entry = entryOf(appRef);
  if (!entry || entry.provider !== provider) {
    throw new AuthConfigError("UNKNOWN_APP_REF", "Authentication application is not configured");
  }
  return entry.load();
}

/**
 * Whether `appRef` is a registered application of `provider`, from the static definitions only
 * (no configuration is loaded, so saving a connection never depends on secrets being present).
 */
function isRegisteredAppRef(appRef, provider) {
  const entry = entryOf(appRef);
  return Boolean(entry && entry.provider === provider);
}

/** The application a connection signs in through: its explicit appRef, else the type's default. */
function effectiveAppRef(connection) {
  if (connection?.appRef) return connection.appRef;
  return DEFAULT_APP_REF[connection?.connectionType] || null;
}

module.exports = {
  ENTRA,
  B2C,
  AuthConfigError,
  DEFAULT_APP_REF,
  getAuthApp,
  isRegisteredAppRef,
  effectiveAppRef,
};
