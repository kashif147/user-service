/**
 * Resolve the ProjectShell application tenant for an identity-provider sign-in.
 *
 * Two different "tenants" are involved and must not be conflated:
 *  - the identity-provider directory (Entra `tid` / the B2C directory) says WHO issued the
 *    token. The login handlers keep validating it exactly as before (trusted directory only);
 *  - the ProjectShell tenant (Tenant._id) decides data isolation. It comes from the
 *    ProjectShell user record, not from the directory, because several ProjectShell tenants may
 *    legitimately trust the same directory.
 *
 * Rules:
 *  1. Candidate tenants = active tenants with an active connection of this type for this
 *     directory. None -> refuse (as before: "Tenant not found for ... directory").
 *  2. An existing user (by Microsoft object id first, then email) inside a candidate tenant
 *     determines the tenant. Exactly one -> that tenant; the user's tenantId is never rewritten.
 *     More than one -> refuse (the same identity provisioned in two tenants needs an explicit
 *     tenant choice, which sign-in does not offer).
 *  3. No existing user -> first-login provisioning only into the single candidate tenant whose
 *     connection allows it (`autoProvisionUsers !== false`, the default). Zero or several -> refuse.
 *
 * With one tenant per directory (today's INMO setup) the result is identical to the previous
 * directory -> tenant lookup. Nothing here reads a tenant from the request, the token's
 * tenant-ish claims (tid/extension_tenantId) or the client.
 */
const Tenant = require("../models/tenant.model");

class IdentityTenantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IdentityTenantError";
    this.code = code;
  }
}

async function findCandidateTenants(connectionType, directoryId) {
  if (!directoryId) return [];
  return Tenant.find({
    isActive: { $ne: false },
    authenticationConnections: {
      $elemMatch: { connectionType, directoryId, isActive: true },
    },
  })
    .select("_id authenticationConnections")
    .lean();
}

function allowsAutoProvision(tenant, connectionType, directoryId) {
  return (tenant.authenticationConnections || []).some(
    (c) =>
      c.connectionType === connectionType &&
      c.directoryId === directoryId &&
      c.isActive === true &&
      c.autoProvisionUsers !== false
  );
}

/**
 * @param {object} args
 * @param {"Entra ID (Azure AD)"|"Azure B2C"} args.connectionType
 * @param {string} args.directoryId  trusted directory the token was validated against
 * @param {string|null} args.email
 * @param {string|null} args.microsoftId  token `oid`
 * @param {import("mongoose").Model} args.UserModel
 * @returns {Promise<{ tenantId: string, existingUser: object|null, candidateTenantIds: string[] }>}
 */
async function resolveApplicationTenant({ connectionType, directoryId, email, microsoftId, UserModel }) {
  const candidates = await findCandidateTenants(connectionType, directoryId);
  if (candidates.length === 0) {
    throw new IdentityTenantError(
      "NO_TRUSTING_TENANT",
      `Tenant not found for ${connectionType} directory: ${directoryId}`
    );
  }
  const candidateTenantIds = candidates.map((t) => t._id.toString());

  let users = [];
  if (microsoftId) {
    users = await UserModel.find({ tenantId: { $in: candidateTenantIds }, userMicrosoftId: microsoftId }).lean();
  }
  if (users.length === 0 && email) {
    users = await UserModel.find({ tenantId: { $in: candidateTenantIds }, userEmail: email }).lean();
  }
  if (users.length > 1) {
    throw new IdentityTenantError(
      "AMBIGUOUS_USER_TENANT",
      "Identity is provisioned in more than one tenant; sign-in cannot choose between them"
    );
  }
  if (users.length === 1) {
    return { tenantId: String(users[0].tenantId), existingUser: users[0], candidateTenantIds };
  }

  const provisioning = candidates.filter((t) => allowsAutoProvision(t, connectionType, directoryId));
  if (provisioning.length !== 1) {
    throw new IdentityTenantError(
      "NOT_PROVISIONED",
      "No ProjectShell account is provisioned for this identity"
    );
  }
  return { tenantId: provisioning[0]._id.toString(), existingUser: null, candidateTenantIds };
}

module.exports = { resolveApplicationTenant, IdentityTenantError };
