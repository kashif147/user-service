/**
 * Display-only organisation context for a successful CRM sign-in: { code, name } of the ProjectShell
 * organisation that the authenticated session belongs to (the user record the JWT is built from).
 * The CRM remembers it for the "Welcome back - Continue with <name>" screen; the code is resolved
 * again by GET /pkce/generate on every sign-in, so returning it grants nothing.
 *
 * Never derived from the browser, the login locator, storage or Microsoft token claims, and never
 * includes the internal tenant id, directory, connection, oid / tid or any configuration. Fails safe:
 * null (the field is simply omitted) when the sign-in state named a different organisation than the
 * session's, the organisation is inactive / missing / malformed, or the lookup fails.
 */
const Tenant = require("../models/tenant.model");

const ORGANISATION_CODE = /^[A-Za-z0-9_-]{1,64}$/;

async function loginOrganisationDisplay(user, loginContext) {
  try {
    const sessionTenantId = user && user.tenantId != null ? String(user.tenantId) : "";
    if (!sessionTenantId) return null;
    if (loginContext && loginContext.tenantId && String(loginContext.tenantId) !== sessionTenantId) return null;
    const tenant = await Tenant.findOne({ _id: sessionTenantId, isActive: { $ne: false } })
      .select("code name")
      .lean();
    const code = tenant && typeof tenant.code === "string" ? tenant.code.trim() : "";
    const name = tenant && typeof tenant.name === "string" ? tenant.name.trim() : "";
    if (!ORGANISATION_CODE.test(code) || !name) return null;
    return { code, name };
  } catch {
    return null;
  }
}

module.exports = { loginOrganisationDisplay };
