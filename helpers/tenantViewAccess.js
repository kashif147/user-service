/**
 * PDP rollout P3 (Q3 / review package E.1): field-level redaction of tenant documents per caller.
 *
 * toTenantView (helpers/authConnectionView.js) stays the response allow-list for connections; every tenant
 * document a controller returns then goes through tenantViewForCaller / tenantViewsForCaller, which drops the
 * field groups the verified caller may not see:
 *
 *   ORG       everything not listed below                       -> whoever passed the route guard (tenant:read,
 *                                                                   own tenant) - unchanged
 *   ORG-BANK  organisationProfile.{iban, bic, bankName, bankAddress}
 *                                                                -> token permission "*" | payments.bank:read |
 *                                                                   tenant:update (the organisation edit form)
 *   SECURITY  authenticationConnections, settings.{passwordPolicy, sessionTimeout, allowSelfRegistration,
 *             maxUsers}, subscription, createdBy, updatedBy      -> "*" | tenant.auth:read
 *
 * Literal token strings from the verified identity (req.ctx.permissions, set by middlewares/auth.js from the
 * gateway-verified headers or the verified Bearer token) - never a query / body flag, never the PDP (the new
 * resources payments.bank / tenant.auth are unknown to it until the P1 catalogue PR). "*" is the computed
 * own-tenant wildcard (ASU only, role.handler.js getUserPermissions). A tenant actor only ever gets its own
 * tenant's document; a document of any other tenant is reduced to ORG (fail closed).
 *
 * Platform principal (req.platform set by middlewares/platformTenantAdmin.js): never ORG-BANK (there is no
 * platform finance claim); SECURITY only when the principal holds platform:tenant:auth-connections:manage:any
 * (the route's own permission, or evaluated for this request) - read:any / update:any never reach another
 * tenant's connections (Z6).
 */
const { evaluatePlatformPermission } = require("../services/platformAuthorizationService");
const { verifyProjectShellToken } = require("../middlewares/auth");

const CONNECTIONS_ANY = "platform:tenant:auth-connections:manage:any";
const BANK_CLAIMS = Object.freeze(["*", "payments.bank:read", "tenant:update"]);
const SECURITY_CLAIMS = Object.freeze(["*", "tenant.auth:read"]);

const ORG_BANK_FIELDS = Object.freeze(["iban", "bic", "bankName", "bankAddress"]);
const SECURITY_SETTINGS_FIELDS = Object.freeze(["passwordPolicy", "sessionTimeout", "allowSelfRegistration", "maxUsers"]);
const SECURITY_TOP_LEVEL_FIELDS = Object.freeze(["authenticationConnections", "subscription", "createdBy", "updatedBy"]);

function tokenPermissions(req) {
  const p = req && req.ctx && req.ctx.permissions;
  return Array.isArray(p) ? p : [];
}

const holdsAny = (perms, claims) => claims.some((c) => perms.includes(c));

/** True when a tenant actor's token carries the tenant-auth read claim ("*" or tenant.auth:read). */
function holdsTenantAuthRead(req) {
  return holdsAny(tokenPermissions(req), SECURITY_CLAIMS);
}

async function platformHoldsConnectionsAny(req) {
  if (req.platform.permission === CONNECTIONS_ANY) return true;
  if (req._p3PlatformConnectionsAny !== undefined) return req._p3PlatformConnectionsAny;
  let allowed = false;
  try {
    const d = await evaluatePlatformPermission({
      authorization: req.headers && req.headers.authorization,
      ctx: req.ctx,
      permission: CONNECTIONS_ANY,
      verifyToken: verifyProjectShellToken,
    });
    allowed = Boolean(d && d.allowed === true);
  } catch (_) {
    allowed = false; // fail closed
  }
  req._p3PlatformConnectionsAny = allowed;
  return allowed;
}

/** { canBank, canSecurity } for this caller. */
async function resolveTenantViewAccess(req) {
  if (req && req.platform) {
    return { platform: true, canBank: false, canSecurity: await platformHoldsConnectionsAny(req) };
  }
  const perms = tokenPermissions(req);
  return { platform: false, canBank: holdsAny(perms, BANK_CLAIMS), canSecurity: holdsAny(perms, SECURITY_CLAIMS) };
}

/** Drop the groups `access` does not allow from one (already toTenantView-ed) tenant document. Pure. */
function applyTenantViewAccess(view, { canBank = false, canSecurity = false } = {}) {
  if (!view || typeof view !== "object") return view;
  const out = { ...view };
  if (!canBank && out.organisationProfile && typeof out.organisationProfile === "object") {
    const org = { ...out.organisationProfile };
    for (const f of ORG_BANK_FIELDS) delete org[f];
    out.organisationProfile = org;
  }
  if (!canSecurity) {
    for (const f of SECURITY_TOP_LEVEL_FIELDS) delete out[f];
    if (out.settings && typeof out.settings === "object") {
      const settings = { ...out.settings };
      for (const f of SECURITY_SETTINGS_FIELDS) delete settings[f];
      out.settings = settings;
    }
  }
  return out;
}

function forTenant(req, view, access) {
  if (access.platform) return applyTenantViewAccess(view, access);
  const own = req && req.ctx && req.ctx.tenantId != null ? String(req.ctx.tenantId) : "";
  const docTenant = view && view._id != null ? String(view._id) : "";
  if (!own || own !== docTenant) return applyTenantViewAccess(view, { canBank: false, canSecurity: false });
  return applyTenantViewAccess(view, access);
}

async function tenantViewForCaller(req, view) {
  return forTenant(req, view, await resolveTenantViewAccess(req));
}

async function tenantViewsForCaller(req, views) {
  const access = await resolveTenantViewAccess(req);
  return (Array.isArray(views) ? views : []).map((v) => forTenant(req, v, access));
}

/**
 * Route guard for the authentication-connection reads (list, connection status, default-role options):
 * tenant.auth:read or "*" on the token. Mount after requireTenant + requireTenantPathAccess (own tenant).
 */
function requireTenantAuthRead(req, res, next) {
  if (holdsTenantAuthRead(req)) return next();
  return res.status(403).json({
    error: {
      message: "Authentication configuration read permission required (tenant.auth:read)",
      code: "TENANT_AUTH_READ_REQUIRED",
      status: 403,
    },
  });
}

module.exports = {
  CONNECTIONS_ANY,
  ORG_BANK_FIELDS,
  SECURITY_SETTINGS_FIELDS,
  SECURITY_TOP_LEVEL_FIELDS,
  resolveTenantViewAccess,
  applyTenantViewAccess,
  tenantViewForCaller,
  tenantViewsForCaller,
  requireTenantAuthRead,
  holdsTenantAuthRead,
};
