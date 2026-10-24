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
 *     connection allows it (`autoProvisionUsers === true`; false or unset = pre-authorised users
 *     only). Zero or several -> refuse. Callers that must never provision (the CRM login without
 *     an organisation code) pass `allowProvisioning: false`: no existing user -> refuse.
 *
 * With one tenant per directory (today's INMO setup) the result is identical to the previous
 * directory -> tenant lookup. Nothing here reads a tenant from the request, the token's
 * tenant-ish claims (tid/extension_tenantId) or the client.
 *
 * CRM sign-ins started for a specific tenant (GET /pkce/generate?tenant=...) use
 * resolveTenantScopedUser below instead; resolveApplicationTenant remains the CRM fallback for
 * logins without a tenant and the B2C portal path.
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

function autoProvisionConnection(tenant, connectionType, directoryId) {
  return (tenant.authenticationConnections || []).find(
    (c) =>
      c.connectionType === connectionType &&
      c.directoryId === directoryId &&
      c.isActive === true &&
      c.autoProvisionUsers === true
  );
}

/**
 * @param {object} args
 * @param {"Entra ID (Azure AD)"|"Azure B2C"} args.connectionType
 * @param {string} args.directoryId  trusted directory the token was validated against
 * @param {string|null} args.email
 * @param {string|null} args.microsoftId  token `oid`
 * @param {import("mongoose").Model} args.UserModel
 * @param {boolean} [args.allowProvisioning=true]  false: existing users only
 * @returns {Promise<{ tenantId: string, existingUser: object|null, candidateTenantIds: string[],
 *   connection: object|null }>}  connection = the auto-provisioning connection (new users only)
 */
async function resolveApplicationTenant({ connectionType, directoryId, email, microsoftId, UserModel, allowProvisioning = true }) {
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
    return { tenantId: String(users[0].tenantId), existingUser: users[0], candidateTenantIds, connection: null };
  }

  const provisioning = allowProvisioning
    ? candidates
        .map((t) => ({ tenant: t, connection: autoProvisionConnection(t, connectionType, directoryId) }))
        .filter((p) => p.connection)
    : [];
  if (provisioning.length !== 1) {
    throw new IdentityTenantError(
      "NOT_PROVISIONED",
      "No ProjectShell account is provisioned for this identity"
    );
  }
  return {
    tenantId: provisioning[0].tenant._id.toString(),
    existingUser: null,
    candidateTenantIds,
    connection: provisioning[0].connection,
  };
}

const isPlaceholderMicrosoftId = (v) => !v || String(v).startsWith("pending-first-login");

/**
 * Tenant-scoped sign-in (the login was started for a specific ProjectShell tenant; its tenantId and
 * connection id come from the server-side OAuth state, never from the request).
 *
 *  1. The stored connection must still be an active Entra connection of that active tenant, and
 *     its directoryId must equal the verified token's `tid`.
 *  2. The user is looked up ONLY inside that tenant: by Entra `oid` (the durable identity; the
 *     record's issuer must be the same directory), else by email but only to claim a record that
 *     has no real oid yet (pre-provisioned / legacy). An email match carrying a DIFFERENT oid is
 *     refused, never taken over.
 *  3. Nobody found -> just-in-time provisioning into this tenant, only when the connection has
 *     `autoProvisionUsers: true` (false or unset -> refuse).
 * Users in other tenants are never read, moved or created here.
 *
 * @returns {Promise<{ tenantId: string, existingUser: object|null, connection: object }>}
 */
async function resolveTenantScopedUser({ tenantId, connectionId, connectionType, directoryId, email, microsoftId, UserModel }) {
  const tenant = await Tenant.findOne({ _id: tenantId, isActive: { $ne: false } })
    .select("_id authenticationConnections")
    .lean();
  const connection = (tenant?.authenticationConnections || []).find(
    (c) => String(c._id) === String(connectionId) && c.connectionType === connectionType && c.isActive === true
  );
  if (!connection) {
    throw new IdentityTenantError("CONNECTION_INVALID", "The sign-in connection is no longer active for this tenant");
  }
  if (!directoryId || connection.directoryId !== directoryId) {
    throw new IdentityTenantError("DIRECTORY_MISMATCH", "Token directory does not match this tenant's connection");
  }
  if (!microsoftId) {
    throw new IdentityTenantError("IDENTITY_INCOMPLETE", "Token has no object id");
  }
  const scopedTenantId = String(tenant._id);

  const byOid = await UserModel.find({ tenantId: scopedTenantId, userMicrosoftId: microsoftId }).lean();
  if (byOid.length > 1) {
    throw new IdentityTenantError("AMBIGUOUS_USER_TENANT", "Identity matches more than one user in this tenant");
  }
  if (byOid.length === 1) {
    const issuer = byOid[0].userIssuer;
    if (issuer && !String(issuer).includes(`/${directoryId}/`)) {
      throw new IdentityTenantError("IDENTITY_CONFLICT", "User record belongs to a different directory");
    }
    return { tenantId: scopedTenantId, existingUser: byOid[0], connection };
  }

  if (email) {
    const byEmail = await UserModel.find({ tenantId: scopedTenantId, userEmail: email }).lean();
    if (byEmail.length === 1) {
      if (!isPlaceholderMicrosoftId(byEmail[0].userMicrosoftId)) {
        throw new IdentityTenantError("IDENTITY_CONFLICT", "Email belongs to a different identity in this tenant");
      }
      return { tenantId: scopedTenantId, existingUser: byEmail[0], connection };
    }
  }

  if (connection.autoProvisionUsers !== true) {
    throw new IdentityTenantError("NOT_PROVISIONED", "This tenant does not create users on first sign-in");
  }
  return { tenantId: scopedTenantId, existingUser: null, connection };
}

module.exports = { resolveApplicationTenant, resolveTenantScopedUser, IdentityTenantError, isPlaceholderMicrosoftId };
