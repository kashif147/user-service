// Trusted tenant for the Azure B2C sign-up API connector (POST /users/validate, Phase 2C B).
//
// The connector call carries no user token, so a tenantId in its body is just a claim. The
// call itself is authenticated (azureB2CBasicAuth), and B2C sets client_id to the B2C app
// registration that ran the user flow; each tenant records that app as the `audience` of its
// active, auto-provisioning "Azure B2C" authentication connection. Exactly one matching tenant is the trusted
// tenant; none or several -> null (callers fail closed).
//
// Sign-up also requires the connection's explicit defaultRoleId: without one, first sign-in would
// refuse JIT (NOT_CONFIGURED), so the B2C account is refused here instead. Only its presence is
// checked; the role itself is validated at provisioning (connectionDefaultRole.checkDefaultRole).
const Tenant = require("../models/tenant.model");

async function resolveB2CConnectorTenantId(clientId) {
  const id = typeof clientId === "string" ? clientId.trim() : "";
  if (!id) return null;
  const tenants = await Tenant.find({
    authenticationConnections: {
      // Sign-up provisions a user, so only auto-provisioning connections qualify
      // (autoProvisionUsers must be explicitly true; see models/tenant.model.js).
      $elemMatch: {
        connectionType: "Azure B2C",
        audience: id,
        isActive: true,
        autoProvisionUsers: true,
        defaultRoleId: { $ne: null },
      },
    },
  })
    .select("_id")
    .limit(2)
    .lean();
  return tenants.length === 1 ? String(tenants[0]._id) : null;
}

module.exports = { resolveB2CConnectorTenantId };
