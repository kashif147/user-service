/**
 * The single place that turns an authentication connection into the protocol configuration a
 * sign-in uses: authority, directory, client id, redirect URI, scopes, issuer, JWKS and the
 * authorize / token / logout endpoints.
 *
 *   resolveConnectionAuthConfig(connection, providerContext) -> frozen config
 *
 * - The DIRECTORY comes from the connection (connection.directoryId). The APPLICATION (client id,
 *   redirect URI, scopes, client secret) comes from the server-side registry
 *   (helpers/authAppRegistry.js), never from the request and never from MongoDB: the connection's
 *   explicit `appRef` when it has one (it must be registered for the connection's provider), else
 *   the provider's compatibility default (crm-entra / portal-b2c), whose use is logged (ids only).
 * - issuer, JWKS URI and endpoints are DERIVED from the directory. The stored `issuerUrl` and
 *   `audience` fields are not read: existing data holds placeholder values there.
 * - The client secret is non-enumerable on the result (it never serialises or logs).
 *
 * Entra (CRM), Phase 3A compatibility mode: the CRM app registration is single-directory, so a
 * connection is usable only when its directoryId equals that app's home directory
 * (AZURE_AD_TENANT_ID). Any other directory fails closed (DIRECTORY_NOT_ENABLED) before an
 * authorize URL, token request or user lookup. Multi-directory sign-in lifts this assertion; the
 * flows already take the directory from the connection.
 *
 * Without a connection (`connection` null) only the legacy entry points remain:
 *  - Entra: the CRM sign-in without an organisation code (and logout). The server cannot know which
 *    customer directory to use, so it uses the app's home directory; that path is existing-users
 *    only and cannot support several directories - it is to be retired or redesigned with
 *    multi-directory sign-in.
 *  - Azure B2C: the shared ProjectShell B2C directory and app (legacy compatibility, not the target).
 *    The portal does not select an organisation before sign-in, so no connection is involved;
 *    `providerContext.policy` picks the user flow. Per-organisation member identity (B2C or
 *    External ID, portal and mobile sharing one connection) resolves through a connection here
 *    later.
 */
const {
  ENTRA,
  B2C,
  AuthConfigError,
  DEFAULT_APP_REF,
  getAuthApp,
} = require("./authAppRegistry");

/**
 * The registered application of `connection` (explicit appRef, else the compatibility default for
 * `connectionType`). A default is logged with ids only, so the remaining implicit connections can
 * be found before appRef becomes required.
 */
function connectionApp(connection, connectionType) {
  if (connection?.appRef) return getAuthApp(connection.appRef, connectionType);
  const appRef = DEFAULT_APP_REF[connectionType];
  if (connection) {
    console.log("Authentication connection uses the compatibility application:", {
      connectionId: connection._id ? String(connection._id) : null,
      appRef,
    });
  }
  return getAuthApp(appRef, connectionType);
}

const ENTRA_AUTHORITY_HOST = "login.microsoftonline.com";
const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B2C_TENANT_NAME = /^[a-z0-9-]{1,64}$/;
const B2C_POLICY = /^[a-zA-Z0-9._-]{1,128}$/;

function withSecret(values, secret) {
  Object.defineProperty(values, "clientSecret", { value: secret, enumerable: false });
  return Object.freeze(values);
}

function resolveEntra(connection) {
  const app = connectionApp(connection, ENTRA);
  let directoryId;
  let mode;
  if (connection) {
    if (connection.isActive !== true) {
      throw new AuthConfigError("CONNECTION_INACTIVE", "Authentication connection is not active");
    }
    directoryId = connection.directoryId;
    mode = "connection";
  } else {
    directoryId = app.compatibilityDirectoryId;
    mode = "legacy-no-organisation";
  }
  if (typeof directoryId !== "string" || !DIRECTORY_GUID.test(directoryId)) {
    throw new AuthConfigError("INVALID_DIRECTORY", "Authentication connection has no valid directory");
  }
  // Phase 3A compatibility assertion (see header).
  if (directoryId !== app.compatibilityDirectoryId) {
    throw new AuthConfigError("DIRECTORY_NOT_ENABLED", "Authentication connection directory is not enabled");
  }
  const base = `https://${ENTRA_AUTHORITY_HOST}/${directoryId}`;
  return withSecret(
    {
      provider: "entra",
      connectionType: ENTRA,
      mode,
      connectionId: connection?._id ? String(connection._id) : null,
      directoryId,
      appRef: app.appRef,
      clientId: app.clientId,
      audience: app.clientId,
      redirectUri: app.redirectUri,
      scopes: app.scopes,
      authorityHost: ENTRA_AUTHORITY_HOST,
      issuer: `${base}/v2.0`,
      jwksUri: `${base}/discovery/v2.0/keys`,
      authorizeEndpoint: `${base}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${base}/oauth2/v2.0/token`,
      logoutEndpoint: `${base}/oauth2/v2.0/logout`,
    },
    app.clientSecret
  );
}

function resolveB2C(connection, providerContext) {
  const app = connectionApp(connection, B2C);
  const { tenantName, directoryId } = app.sharedDirectory;
  if (!B2C_TENANT_NAME.test(tenantName)) {
    throw new AuthConfigError("INVALID_DIRECTORY", "Azure B2C tenant name is not valid");
  }
  const policy = providerContext.policy;
  if (policy != null && (typeof policy !== "string" || !B2C_POLICY.test(policy))) {
    throw new AuthConfigError("INVALID_POLICY", "Invalid B2C policy");
  }
  const host = `https://${tenantName}.b2clogin.com`;
  const flow = policy ? `${host}/${tenantName}.onmicrosoft.com/${policy}` : null;
  return withSecret(
    {
      provider: "azure-b2c",
      connectionType: B2C,
      mode: "legacy-shared-directory",
      connectionId: null,
      directoryId,
      tenantName,
      policy: policy || null,
      appRef: app.appRef,
      clientId: app.clientId,
      audience: app.clientId,
      redirectUri: app.redirectUri,
      scopes: app.scopes,
      authorityHost: `${tenantName}.b2clogin.com`,
      // B2C issues `iss` with the lower-case tenant host and the directory GUID.
      issuer: `${host}/${directoryId}/v2.0/`,
      // B2C publishes endpoints and signing keys per user flow (policy).
      jwksUri: flow && `${flow}/discovery/v2.0/keys`,
      authorizeEndpoint: flow && `${flow}/oauth2/v2.0/authorize`,
      tokenEndpoint: flow && `${flow}/oauth2/v2.0/token`,
      logoutEndpoint: flow && `${flow}/oauth2/v2.0/logout`,
    },
    app.clientSecret
  );
}

/**
 * @param {object|null} connection  the selected authentication connection (null: legacy entry
 *   points only, see header)
 * @param {{connectionType?: string, policy?: string}} [providerContext]  connectionType is required
 *   when `connection` is null; policy selects the B2C user flow
 * @returns {Readonly<object>}  resolved configuration; `clientSecret` is non-enumerable
 * @throws {AuthConfigError|import("./entraConfig").EntraConfigError}
 */
function resolveConnectionAuthConfig(connection, providerContext = {}) {
  const connectionType = connection ? connection.connectionType : providerContext.connectionType;
  if (connectionType === ENTRA) return resolveEntra(connection || null);
  if (connectionType === B2C) return resolveB2C(connection || null, providerContext);
  throw new AuthConfigError("UNSUPPORTED_PROVIDER", "Unsupported authentication provider");
}

// Organisation-level configuration problems: refused like an unavailable organisation, never as a
// server fault, and never with details.
const ORGANISATION_CONFIG_CODES = new Set([
  "CONNECTION_INACTIVE",
  "INVALID_DIRECTORY",
  "DIRECTORY_NOT_ENABLED",
  "UNKNOWN_APP_REF",
  "UNSUPPORTED_PROVIDER",
]);
const isOrganisationConfigError = (e) => e instanceof AuthConfigError && ORGANISATION_CONFIG_CODES.has(e.code);

module.exports = {
  resolveConnectionAuthConfig,
  isOrganisationConfigError,
  AuthConfigError,
  ENTRA_AUTHORITY_HOST,
};
