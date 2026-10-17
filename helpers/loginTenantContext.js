/**
 * Tenant-scoped CRM sign-in: which ProjectShell tenant a Microsoft (Entra ID) login is FOR.
 *
 * Several ProjectShell tenants may trust the same Entra directory, app registration, issuer and
 * audience, so nothing in the Microsoft token can say which tenant the user meant. The tenant is
 * chosen BEFORE the redirect (GET /pkce/generate?tenant=<code>), resolved here to that tenant's
 * single active Entra connection, and stored server-side against the OAuth `state`
 * (helpers/pkceStateStore.js). The callback restores it from the state alone (loadLoginConnection).
 * The connection, not the environment, says which directory the login uses
 * (helpers/connectionAuthConfig.js); the organisation code is only a locator.
 *
 * The browser-facing locator is the Organisation Code ONLY. The internal tenant _id is never
 * accepted here (it is backend-only); a value that is not a known code - including a raw _id - gets
 * the same generic refusal as an unknown or unconfigured organisation.
 *
 * Choosing a tenant grants nothing by itself: the callback still verifies the token, checks its
 * `tid` against the stored connection, and only finds or creates the user INSIDE that tenant
 * (handlers/azure.ad.handler.js).
 */
const Tenant = require("../models/tenant.model");

const ENTRA = "Entra ID (Azure AD)";
const TENANT_SELECTOR = /^[A-Za-z0-9_-]{1,64}$/;

class LoginTenantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LoginTenantError";
    this.code = code;
  }
}

function activeEntraConnections(tenant) {
  return (tenant.authenticationConnections || []).filter(
    (c) => c.connectionType === ENTRA && c.isActive === true
  );
}

/**
 * @param {string} selector  Organisation Code (e.g. "DEVTENANTB"); never the internal Tenant._id
 * @returns {Promise<{tenantId: string, connectionId: string, connection: object}>}  the
 *   organisation and its one active Entra connection. None or several -> LoginTenantError.
 */
async function resolveLoginTenant(selector) {
  const raw = selector == null ? "" : String(selector).trim();
  if (!TENANT_SELECTOR.test(raw)) {
    throw new LoginTenantError("INVALID_TENANT", "Unknown organisation");
  }
  const tenants = await Tenant.find({ code: raw.toUpperCase(), isActive: { $ne: false } })
    .select("_id code authenticationConnections")
    .lean();
  if (tenants.length !== 1) {
    throw new LoginTenantError("UNKNOWN_TENANT", "Unknown organisation");
  }
  const connections = activeEntraConnections(tenants[0]);
  if (connections.length === 0) {
    throw new LoginTenantError("NO_ENTRA_CONNECTION", "Microsoft sign-in is not set up for this organisation");
  }
  if (connections.length > 1) {
    throw new LoginTenantError("MULTIPLE_ENTRA_CONNECTIONS", "Microsoft sign-in is not set up for this organisation");
  }
  return {
    tenantId: String(tenants[0]._id),
    connectionId: String(connections[0]._id),
    connection: connections[0],
  };
}

/**
 * The Entra connection a login was started for, reloaded from the ids kept in the server-side
 * OAuth state. It must still be an active Entra connection of that active organisation.
 * @param {{tenantId: string, connectionId: string}} loginContext
 * @returns {Promise<object>} the connection
 */
async function loadLoginConnection({ tenantId, connectionId }) {
  const tenant = await Tenant.findOne({ _id: String(tenantId), isActive: { $ne: false } })
    .select("_id authenticationConnections")
    .lean();
  const connection = tenant
    ? activeEntraConnections(tenant).find((c) => String(c._id) === String(connectionId))
    : null;
  if (!connection) {
    throw new LoginTenantError("CONNECTION_INVALID", "The sign-in connection is no longer active for this organisation");
  }
  return connection;
}

module.exports = { resolveLoginTenant, loadLoginConnection, LoginTenantError, ENTRA };
