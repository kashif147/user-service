const Tenant = require("../models/tenant.model");
const { pickInto, TENANT_ORG_FIELDS, TENANT_ORG_BANK_FIELDS } = require("../helpers/tenantViewAccess");

/**
 * PDP rollout P3 (owner item O6 / finding N3): the organisation's creditor / beneficiary details for SERVER-SIDE
 * document generation (profile-service payment-form hydration).
 *
 *   GET /internal/tenants/:tenantId/creditor-profile          operation tenant_creditor_profile
 *
 * Mounted OUTSIDE /api (the gateway proxies only /user-service/{api,auth,pkce}/...). Its only authority is the
 * p5-svc-sig/1 signature verified by middlewares/serviceSignatureAuth.js (caller profile-service, audience
 * user-service, mode TENANT_CREDITOR_SERVICE_AUTH_MODE; any user / gateway identity header -> 404). This handler
 * runs only after a valid signature: req.serviceAuth.tenantId is the SIGNED x-tenant-id, and the path tenant must
 * equal it (a signature for tenant A never reads tenant B).
 *
 * Why: the user-facing GET /api/tenants/:id is field-redacted per caller (ORG-BANK needs payments.bank:read,
 * tenant:update or "*"), but the beneficiary IBAN / BIC / OIN are printed on every member's standing-order and
 * direct-debit mandate form, whoever creates it. Fetching them with the caller's forwarded token returned 403 for
 * every non-ASU caller, which the profile client swallowed into {} -> blank creditor snapshots (N3).
 *
 * Response, built from explicit allow-lists only (helpers/tenantViewAccess.js): { tenantId, name, code, branding,
 * organisationProfile } with the ORG + ORG-BANK organisation-profile fields. Never settings, subscription,
 * authenticationConnections, createdBy / updatedBy, or any field not on those lists.
 */
const CREDITOR_PROFILE_FIELDS = Object.freeze({
  name: true,
  code: true,
  branding: TENANT_ORG_FIELDS.branding,
  organisationProfile: TENANT_ORG_FIELDS.organisationProfile,
});

function toCreditorProfileView(tenant) {
  const t = tenant && typeof tenant.toObject === "function" ? tenant.toObject() : tenant || {};
  const out = pickInto({}, t, CREDITOR_PROFILE_FIELDS);
  pickInto(out, t, { organisationProfile: TENANT_ORG_BANK_FIELDS.organisationProfile });
  return { tenantId: String(t._id), ...out, branding: out.branding || {}, organisationProfile: out.organisationProfile || {} };
}

async function getCreditorProfile(req, res) {
  try {
    const signedTenant = req.serviceAuth && req.serviceAuth.tenantId;
    const tenantId = String(req.params.tenantId || "");
    if (!signedTenant || tenantId !== String(signedTenant)) {
      return res.status(403).json({ success: false, code: "TENANT_MISMATCH", message: "Tenant mismatch" });
    }
    const tenant = await Tenant.findOne({ _id: tenantId })
      .select({ name: 1, code: 1, branding: 1, organisationProfile: 1 })
      .lean();
    if (!tenant) return res.status(404).json({ success: false, code: "NOT_FOUND", message: "Tenant not found" });
    return res.status(200).json({ status: "success", data: toCreditorProfileView(tenant) });
  } catch (err) {
    console.error("[internal-creditor-profile] lookup failed");
    return res.status(500).json({ success: false, code: "INTERNAL_ERROR", message: "Failed to load creditor profile" });
  }
}

module.exports = { getCreditorProfile, toCreditorProfileView, CREDITOR_PROFILE_FIELDS };
