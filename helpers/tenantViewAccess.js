/**
 * PDP rollout P3 (Q3 / review package E.1): field-level redaction of tenant documents per caller, by EXPLICIT
 * ALLOW-LISTS. Every tenant document a controller returns goes through toTenantView (helpers/authConnectionView.js,
 * the per-connection allow-list) and then tenantViewForCaller / tenantViewsForCaller, which BUILD the response from
 * the allow-listed field groups the verified caller may see. A field that is in none of the lists below (a new
 * schema field, an internal marker, __v, anything stored by mistake) is never returned to anyone.
 *
 *   ORG       TENANT_ORG_FIELDS        -> whoever passed the route guard (tenant:read, own tenant)
 *   ORG-BANK  TENANT_ORG_BANK_FIELDS   -> token permission "*" | payments.bank:read | tenant:update
 *   SECURITY  TENANT_SECURITY_FIELDS   -> "*" | tenant.auth:read
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
 *
 * Spec format: { field: true } copies that value as stored (a leaf, or an array of strings); { field: { ... } }
 * recurses into a sub-document with its own allow-list. Nothing is copied by default.
 */
const { evaluatePlatformPermission } = require("../services/platformAuthorizationService");
const { verifyProjectShellToken } = require("../middlewares/auth");

const CONNECTIONS_ANY = "platform:tenant:auth-connections:manage:any";
const BANK_CLAIMS = Object.freeze(["*", "payments.bank:read", "tenant:update"]);
const SECURITY_CLAIMS = Object.freeze(["*", "tenant.auth:read"]);

const LEAF = true;
const TENANT_ORG_FIELDS = Object.freeze({
  _id: LEAF,
  name: LEAF,
  code: LEAF,
  description: LEAF,
  domain: LEAF,
  contactEmail: LEAF,
  contactPhone: LEAF,
  address: { street: LEAF, city: LEAF, state: LEAF, zipCode: LEAF, country: LEAF },
  organisationProfile: {
    legalName: LEAF,
    tradingName: LEAF,
    registrationNumber: LEAF,
    charityNumber: LEAF,
    vatNumber: LEAF,
    website: LEAF,
    email: LEAF,
    contactNumber: LEAF,
    sepaOriginatorIdentificationNumber: LEAF, // printed on every member mandate: organisation detail
  },
  branding: {
    logoUrl: LEAF,
    logoDarkUrl: LEAF,
    faviconUrl: LEAF,
    primaryColor: LEAF,
    secondaryColor: LEAF,
    accentColor: LEAF,
    secondaryBackgroundColor: LEAF,
    portalTitle: LEAF,
    emailFooterText: LEAF,
    letterHeaderUrl: LEAF,
    letterFooterUrl: LEAF,
  },
  regionalSettings: { timezone: LEAF, locale: LEAF, currency: LEAF, dateFormat: LEAF },
  settings: {
    // read by subscription-service lifecycle scheduling and the CRM lifecycle settings page
    lifecycleBatches: {
      reminder: { generateMode: LEAF, executeMode: LEAF },
      cancellation: { generateMode: LEAF, executeMode: LEAF },
      schedule: { dayMode: LEAF },
      notificationRecipientRoleCodes: LEAF,
    },
  },
  status: LEAF,
  isActive: LEAF,
  createdAt: LEAF,
  updatedAt: LEAF,
});
const TENANT_ORG_BANK_FIELDS = Object.freeze({
  organisationProfile: {
    bankName: LEAF,
    bankAddress: {
      buildingOrHouse: LEAF,
      streetOrRoad: LEAF,
      areaOrTown: LEAF,
      countyCityOrPostCode: LEAF,
      eircode: LEAF,
      country: LEAF,
    },
    iban: LEAF,
    bic: LEAF,
  },
});
const TENANT_SECURITY_FIELDS = Object.freeze({
  // each connection is already reduced to CONNECTION_RESPONSE_FIELDS by toTenantView / toConnectionView
  authenticationConnections: LEAF,
  settings: {
    maxUsers: LEAF,
    allowSelfRegistration: LEAF,
    sessionTimeout: LEAF,
    passwordPolicy: {
      minLength: LEAF,
      requireUppercase: LEAF,
      requireLowercase: LEAF,
      requireNumbers: LEAF,
      requireSpecialChars: LEAF,
    },
  },
  subscription: { plan: LEAF, startDate: LEAF, endDate: LEAF, autoRenew: LEAF },
  createdBy: LEAF,
  updatedBy: LEAF,
});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
const asPlain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v);

/** Copy only the allow-listed fields of `src` (see spec format above) into `dst`. Pure. */
function pickInto(dst, src, spec) {
  const from = asPlain(src);
  if (!isPlainObject(from)) return dst;
  for (const [key, rule] of Object.entries(spec)) {
    if (!Object.prototype.hasOwnProperty.call(from, key) || from[key] === undefined) continue;
    const value = asPlain(from[key]);
    if (rule === LEAF) {
      dst[key] = value;
    } else if (isPlainObject(value)) {
      const sub = pickInto(isPlainObject(dst[key]) ? dst[key] : {}, value, rule);
      dst[key] = sub;
    }
  }
  return dst;
}

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

/** Build the response for one (already toTenantView-ed) tenant document from the allowed groups only. Pure. */
function applyTenantViewAccess(view, { canBank = false, canSecurity = false } = {}) {
  if (!view || typeof view !== "object") return view;
  const out = pickInto({}, view, TENANT_ORG_FIELDS);
  if (canBank) pickInto(out, view, TENANT_ORG_BANK_FIELDS);
  if (canSecurity) pickInto(out, view, TENANT_SECURITY_FIELDS);
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
  TENANT_ORG_FIELDS,
  TENANT_ORG_BANK_FIELDS,
  TENANT_SECURITY_FIELDS,
  pickInto,
  resolveTenantViewAccess,
  applyTenantViewAccess,
  tenantViewForCaller,
  tenantViewsForCaller,
  requireTenantAuthRead,
  holdsTenantAuthRead,
};
