const crypto = require("crypto");
const Tenant = require("../models/tenant.model");

/**
 * PDP rollout P3 (owner item O6 / finding N3): the organisation's creditor / beneficiary details for SERVER-SIDE
 * document generation (profile-service payment-form hydration; later communication letters).
 *
 *   GET /internal/tenants/:tenantId/creditor-profile
 *   x-service-secret: <INTERNAL_TENANT_PROFILE_SECRET>   (mounted OUTSIDE /api: the gateway proxies only
 *   x-tenant-id: <same id as the path>                    /user-service/{api,auth,pkce}/..., so this path is not
 *                                                         publicly reachable - same as /internal/platform-auth)
 *
 * Why: the user-facing GET /api/tenants/:id is field-redacted per caller (ORG-BANK needs payments.bank:read,
 * tenant:update or "*"), but the beneficiary IBAN / BIC / OIN are printed on every member's standing-order and
 * direct-debit mandate form, whoever creates it (CRM staff without bank rights, or the member on the portal).
 * Fetching them with the caller's forwarded token returned 403 for every non-ASU caller, which the profile
 * client swallowed into {} -> blank creditor snapshots (N3).
 *
 * Caller trust: a shared service secret, constant-time compare; unset / short secret = every call 403 (fail
 * closed, the same shape as the other /internal surfaces). No user identity is used or required. The tenant is
 * the explicit path id, which must equal x-tenant-id (the calling service's trusted tenant for the request).
 *
 * Response (field allow-list, nothing else): { tenantId, name, code, branding, organisationProfile: { legalName,
 * tradingName, registrationNumber, charityNumber, vatNumber, website, email, contactNumber, bankName,
 * bankAddress, iban, bic, sepaOriginatorIdentificationNumber } }. Never settings, subscription,
 * authenticationConnections, createdBy / updatedBy.
 */
const MIN_SECRET_LENGTH = 32;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const ORG_PROFILE_FIELDS = Object.freeze([
  "legalName",
  "tradingName",
  "registrationNumber",
  "charityNumber",
  "vatNumber",
  "website",
  "email",
  "contactNumber",
  "bankName",
  "bankAddress",
  "iban",
  "bic",
  "sepaOriginatorIdentificationNumber",
]);

function secretMatches(provided) {
  const secret = process.env.INTERNAL_TENANT_PROFILE_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return false;
  if (typeof provided !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireTenantProfileSecret(req, res, next) {
  if (!secretMatches(req.headers["x-service-secret"])) {
    return res.status(403).json({ status: "fail", message: "Forbidden" });
  }
  return next();
}

function plain(v) {
  return v && typeof v.toObject === "function" ? v.toObject() : v;
}

function toCreditorProfileView(tenant) {
  const t = plain(tenant) || {};
  const org = plain(t.organisationProfile) || {};
  const organisationProfile = {};
  for (const f of ORG_PROFILE_FIELDS) {
    if (org[f] !== undefined) organisationProfile[f] = plain(org[f]);
  }
  return {
    tenantId: String(t._id),
    name: t.name,
    code: t.code,
    branding: plain(t.branding) || {},
    organisationProfile,
  };
}

async function getCreditorProfile(req, res) {
  try {
    const tenantId = String(req.params.tenantId || "");
    const headerTenant = String(req.headers["x-tenant-id"] || "");
    if (!OBJECT_ID.test(tenantId) || headerTenant !== tenantId) {
      return res.status(400).json({ status: "fail", message: "Invalid tenant" });
    }
    const tenant = await Tenant.findOne({ _id: tenantId })
      .select({ name: 1, code: 1, branding: 1, organisationProfile: 1 })
      .lean();
    if (!tenant) return res.status(404).json({ status: "fail", message: "Tenant not found" });
    return res.status(200).json({ status: "success", data: toCreditorProfileView(tenant) });
  } catch (err) {
    console.error("[internal-creditor-profile] lookup failed");
    return res.status(500).json({ status: "error", message: "Failed to load creditor profile" });
  }
}

module.exports = {
  requireTenantProfileSecret,
  getCreditorProfile,
  toCreditorProfileView,
  ORG_PROFILE_FIELDS,
};
