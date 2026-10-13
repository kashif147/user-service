/**
 * Tenant-scoped CRM sign-in: which ProjectShell tenant a Microsoft (Entra ID) login is FOR.
 *
 * Several ProjectShell tenants may trust the same Entra directory, app registration, issuer and
 * audience, so nothing in the Microsoft token can say which tenant the user meant. The tenant is
 * chosen BEFORE the redirect (GET /pkce/generate?tenant=<code>), resolved here to that tenant's
 * active Entra connection, and stored server-side against the OAuth `state`
 * (helpers/pkceStateStore.js). The callback restores it from the state alone.
 *
 * Choosing a tenant grants nothing by itself: the callback still verifies the token, checks its
 * `tid` against the stored connection, and only finds or creates the user INSIDE that tenant
 * (handlers/azure.ad.handler.js).
 */
const mongoose = require("mongoose");
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

function findActiveEntraConnection(tenant, directoryId) {
  return (tenant.authenticationConnections || []).find(
    (c) => c.connectionType === ENTRA && c.isActive === true && c.directoryId === directoryId
  );
}

/**
 * @param {string} selector  tenant code (e.g. "DEVTENANTB") or Tenant._id
 * @param {string} directoryId  the Entra directory this deployment signs users in against
 * @returns {Promise<{tenantId: string, connectionId: string}>}
 */
async function resolveLoginTenant(selector, directoryId) {
  const raw = selector == null ? "" : String(selector).trim();
  if (!TENANT_SELECTOR.test(raw)) {
    throw new LoginTenantError("INVALID_TENANT", "Unknown organisation");
  }
  const or = [{ code: raw.toUpperCase() }];
  if (mongoose.Types.ObjectId.isValid(raw) && /^[0-9a-f]{24}$/i.test(raw)) or.push({ _id: raw });

  const tenants = await Tenant.find({ $or: or, isActive: { $ne: false } })
    .select("_id code authenticationConnections")
    .lean();
  if (tenants.length !== 1) {
    throw new LoginTenantError("UNKNOWN_TENANT", "Unknown organisation");
  }
  const connection = findActiveEntraConnection(tenants[0], directoryId);
  if (!connection) {
    throw new LoginTenantError("NO_ENTRA_CONNECTION", "Microsoft sign-in is not set up for this organisation");
  }
  return { tenantId: String(tenants[0]._id), connectionId: String(connection._id) };
}

module.exports = { resolveLoginTenant, findActiveEntraConnection, LoginTenantError, ENTRA };
