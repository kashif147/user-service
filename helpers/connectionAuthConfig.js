/**
 * The single place that turns an authentication connection into the protocol configuration a
 * sign-in uses: authority, directory, client id, redirect URI, scopes, issuer, JWKS and the
 * authorize / token / logout endpoints.
 *
 *   resolveConnectionAuthConfig(connection, providerContext) -> frozen config
 *
 * - The DIRECTORY comes from the connection (connection.directoryId = Microsoft Directory (tenant)
 *   ID). The APPLICATION is fixed per provider and comes from server configuration
 *   (helpers/authAppRegistry.js), never from the request and never from MongoDB: Entra -> the
 *   shared CRM app (entraCrm), Azure B2C -> the legacy shared B2C app. Organisations share the
 *   Application (client) ID and are distinguished by directory only. Stored legacy fields
 *   (`appRef`, `directoryOwnership`, `issuerUrl`, `audience`) are never read here.
 * - issuer, JWKS URI and endpoints are DERIVED from the directory.
 * - The client secret is non-enumerable on the result (it never serialises or logs).
 *
 * Entra (CRM) directories:
 *  - Single-directory compatibility mode (default): a connection is usable only when its
 *    directoryId equals the CRM app's home directory (AZURE_AD_TENANT_ID). Any other directory
 *    fails closed (DIRECTORY_NOT_ENABLED) before an authorize URL, token request or user lookup.
 *  - Multi-directory mode (Stage 5a, ENTRA_CRM_MULTI_DIRECTORY exactly "true"): only that
 *    assertion is lifted, and only for a SELECTED organisation connection - its directory becomes
 *    authoritative. Every other check stays, the token's tid must still equal it, and the
 *    application is still the one shared CRM app. The connection must also hold a verified
 *    directory claim (Stage 5b, helpers/directoryClaimGate.js: checked by the callers at login
 *    start and again at the callback; DIRECTORY_NOT_CLAIMED otherwise).
 *  - Always refused: anything that is not a directory GUID (common / organizations / consumers)
 *    and the Microsoft personal-account (consumer) directory.
 *
 * Without a connection (`connection` null) only the legacy entry points remain:
 *  - Entra: the CRM sign-in without an organisation code (and logout). The server cannot know which
 *    customer directory to use, so it uses the app's home directory - also in multi-directory
 *    mode, where it never becomes a generic entry point; that path is existing-users only and is
 *    to be retired or redesigned.
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
  getEntraCrmApp,
  getLegacySharedB2CApp,
} = require("./authAppRegistry");

const ENTRA_AUTHORITY_HOST = "login.microsoftonline.com";
const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Microsoft personal accounts (MSA) sign in through this fixed directory; it is never an
// organisation's directory.
const CONSUMER_DIRECTORY_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const B2C_TENANT_NAME = /^[a-z0-9-]{1,64}$/;
const B2C_POLICY = /^[a-zA-Z0-9._-]{1,128}$/;

function withSecret(values, secret) {
  Object.defineProperty(values, "clientSecret", { value: secret, enumerable: false });
  return Object.freeze(values);
}

function resolveEntra(connection) {
  const app = getEntraCrmApp();
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
  if (directoryId.toLowerCase() === CONSUMER_DIRECTORY_ID) {
    throw new AuthConfigError("INVALID_DIRECTORY", "Personal Microsoft account directory is not supported");
  }
  // Home-directory compatibility assertion (see header): lifted only for a selected organisation
  // connection in multi-directory mode, never for the no-code path.
  const directoryAuthoritative = mode === "connection" && app.multiDirectory === true;
  if (!directoryAuthoritative && directoryId !== app.compatibilityDirectoryId) {
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
      application: app.application,
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

function resolveB2C(_connection, providerContext) {
  const app = getLegacySharedB2CApp();
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
      application: app.application,
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
  "DIRECTORY_NOT_CLAIMED",
  "UNSUPPORTED_PROVIDER",
]);
const isOrganisationConfigError = (e) => e instanceof AuthConfigError && ORGANISATION_CONFIG_CODES.has(e.code);

// Stage 5c "Connect Microsoft Entra": the directory being connected is not trusted yet, so the
// sign-in uses the `organizations` authority (work/school accounts only; `common` would also admit
// personal accounts). The verified token's tid then names the directory (helpers/entraConnect.js).
const CONNECT_AUTHORITY = "organizations";
// openid profile email only: no offline_access, so Connect never receives a refresh token.
const CONNECT_SCOPES = "openid profile email";

/**
 * Protocol configuration of a Connect sign-in: the one shared CRM application (same client id,
 * credential and registered redirect URI as sign-in), `organizations` endpoints and keys. The
 * redirect URI is the existing registered CRM redirect URI - temporary compatibility until the
 * central ProjectShell callback; no customer-specific redirect URI exists and none comes from the
 * browser.
 * @returns {Readonly<object>}  `clientSecret` is non-enumerable
 * @throws {import("./entraConfig").EntraConfigError}
 */
function resolveEntraConnectConfig() {
  const app = getEntraCrmApp();
  const base = `https://${ENTRA_AUTHORITY_HOST}/${CONNECT_AUTHORITY}`;
  return withSecret(
    {
      provider: "entra",
      connectionType: ENTRA,
      mode: "entra-connect",
      application: app.application,
      clientId: app.clientId,
      audience: app.clientId,
      redirectUri: app.redirectUri,
      scopes: CONNECT_SCOPES,
      authorityHost: ENTRA_AUTHORITY_HOST,
      // The issuer is per directory: https://login.microsoftonline.com/{tid}/v2.0, checked
      // against the verified token's own tid.
      issuerTemplate: `https://${ENTRA_AUTHORITY_HOST}/{tid}/v2.0`,
      jwksUri: `${base}/discovery/v2.0/keys`,
      authorizeEndpoint: `${base}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${base}/oauth2/v2.0/token`,
    },
    app.clientSecret
  );
}

module.exports = {
  resolveConnectionAuthConfig,
  resolveEntraConnectConfig,
  isOrganisationConfigError,
  AuthConfigError,
  ENTRA_AUTHORITY_HOST,
};
