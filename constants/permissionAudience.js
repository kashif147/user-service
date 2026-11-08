/**
 * PDP rollout P4 - PROPOSED permission audience per catalogue code (bounded-pdp-implementation-proposal §2b).
 *
 * Audience = which verified caller type a permission code is meant for:
 *   CRM     CRM staff only
 *   PORTAL  portal members only
 *   BOTH    either (only where a real portal consumer exists, and that route is ownership-checked)
 * A code that is not listed here (and has no stored `audience`) is "not back-filled": the evaluator keeps the
 * legacy per-resource category rule for it (MENU_*, CRM_*, NOTIFICATION_READ, DASHBOARD_READ, report nav
 * codes, obsolete / test codes, platform-adjacent admin codes).
 *
 * Source precedence in the evaluator: the stored catalogue `audience` (P1 rows) wins; this map only fills rows
 * without one. P4 uses it in SHADOW only (services/policyEvaluationService.js, PDP_AUDIENCE_MODE). Nothing here
 * changes a decision. P5 enforce reads the catalogue only, so this map must be back-filled into the catalogue
 * (ledgered script, owner-approved write) before P5.
 *
 * Keys are catalogue codes (Permission.code). tests/permissionAudience.p4.test.js pins every key to an active
 * DEV catalogue row and every stored audience to the same value here.
 */
const AUDIENCES = Object.freeze(["CRM", "PORTAL", "BOTH"]);

const crm = [
  // profile / application (CRM routes; the portal application flow uses portal:* + ownership)
  "PROFILE_CREATE", "PROFILE_READ", "PROFILE_WRITE", "PROFILE_DELETE",
  "APPLICATION_CREATE", "APPLICATION_READ", "APPLICATION_WRITE", "APPLICATION_DELETE",
  // correspondence staff routes (the member letter read is COMMUNICATION_READ, BOTH)
  "COMMUNICATION_CREATE", "COMMUNICATION_WRITE", "COMMUNICATION_DELETE",
  // membership lifecycle
  "SUBSCRIPTIONS_CREATE", "SUBSCRIPTIONS_READ", "SUBSCRIPTIONS_WRITE", "SUBSCRIPTIONS_DELETE",
  "TRANSFERREQUESTS_CREATE", "TRANSFERREQUESTS_READ", "TRANSFERREQUESTS_WRITE", "TRANSFERREQUESTS_DELETE",
  "CHANGEOFCATEGORY_CREATE", "CHANGEOFCATEGORY_READ", "CHANGEOFCATEGORY_WRITE", "CHANGEOFCATEGORY_DELETE",
  // finance (accounts.reports:read has two codes on DEV; both CRM)
  "ACCOUNTS.REPORTS_READ", "ACCOUNTS_REPORTS", "PAYMENTS_READ", "PAYMENTS_WRITE",
  "AUDIT_READ", "TENANT_READ",
  // events administration (portal browse is EVENTS_READ, BOTH; portal booking is REGISTRATIONS_*)
  "EVENTS_CREATE", "EVENTS_WRITE", "EVENTS_DELETE",
  // issues (every issues* resource)
  "ISSUES_READ", "ISSUES_WRITE",
  "ISSUES_COMPLAINTS_READ", "ISSUES_COMPLAINTS_WRITE",
  "ISSUES_DATAPROTECTION_READ", "ISSUES_DATAPROTECTION_WRITE",
  "ISSUES_FTP_READ", "ISSUES_FTP_WRITE",
  "ISSUES_IR_READ", "ISSUES_IR_WRITE",
  "ISSUES_TEMPLATES_READ", "ISSUES_TEMPLATES_WRITE",
  "APPLICATION_PAYMENT_LINKS_READ", "APPLICATION_PAYMENT_LINKS_WRITE",
  "DIRECTORY_READ",
  "PRICING_READ", "PRICING_WRITE", "PRODUCT_TYPE_READ",
  "NOTIFICATION_CREATE", "TEMPLATE_READ",
  // P1 rows (stored audience CRM; listed so the map is the single proposed source)
  "PAYMENTS.BANK_READ", "TENANT.AUTH_READ", "CONTACT_READ",
  "REPORTING.STATISTICS_READ", "REPORTING.LISTINGS_READ", "REPORTING.FINANCE_READ",
  "REPORTING.TEMPLATES_READ", "REPORTING.TEMPLATES_WRITE",
];

const both = [
  "COMMUNICATION_READ", // portal own-letter path (communication-service internalCaller)
  "EVENTS_READ", // portal event / course browse
  "PRODUCT_READ", // portal /api/products
  "LOOKUP_READ", "LOOKUPTYPE_READ",
  "ACCOUNTS.MEMBER_READ", // P1 row (stored audience BOTH)
];

const portal = [
  "PORTAL_CREATE", "PORTAL_READ", "PORTAL_WRITE", "PORTAL_DELETE",
  "REGISTRATIONS_CREATE", "REGISTRATIONS_READ", "REGISTRATIONS_WRITE",
];

const PROPOSED_AUDIENCE = Object.freeze(
  Object.fromEntries([
    ...crm.map((c) => [c, "CRM"]),
    ...both.map((c) => [c, "BOTH"]),
    ...portal.map((c) => [c, "PORTAL"]),
  ]),
);

const PERMISSION_AUDIENCE_MAP_VERSION = "p4-audience-v1";

/** Verified caller type -> audience class, or null (SYSTEM, missing, unknown: no audience admits it). */
function audienceClassOf(userType) {
  const t = String(userType || "").trim().toUpperCase();
  if (t === "CRM") return "CRM";
  if (t === "PORTAL" || t === "MEMBER") return "PORTAL";
  return null;
}

/** Does `audience` admit a caller of `cls` (from audienceClassOf)? */
function audienceAdmits(audience, cls) {
  if (!cls) return false;
  return audience === "BOTH" || audience === cls;
}

module.exports = {
  AUDIENCES,
  PROPOSED_AUDIENCE,
  PERMISSION_AUDIENCE_MAP_VERSION,
  audienceClassOf,
  audienceAdmits,
};
