/**
 * P5 / D6: tenant LIFECYCLE (delete, decommission, status) is PLATFORM-ONLY.
 *
 * Mounted on the TENANT-ACTOR chains of routes/tenant.routes.js only. A platform principal is decided earlier by
 * platformTenantAdmin (exact platform:tenant:delete:any / platform:tenant:update:any) and never reaches these
 * guards; every tenant actor does - ASU, ordinary users and a stale legacy SU / "*" token alike. The PDP is not
 * the place for this: ASU's computed own-tenant authority (ASU_OWN_TENANT_ACCESS) permits every action on the
 * "tenant" resource, and tenant:delete also gates legitimate own-tenant configuration deletes (offices,
 * departments, contacts, public holidays), so removing TENANT_DELETE from a role alone would not close the route.
 *
 *   refuseTenantLifecycle        DELETE /tenants/:id, PUT /tenants/:id/status -> always 403
 *   refuseTenantLifecycleFields  PUT /tenants/:id -> 403 when the body would CHANGE isActive / status, or carries
 *                                an update operator ($set, $unset, ...) that could change them out of sight.
 *                                Sending the stored values unchanged (the CRM tenant form does) still passes.
 * Runs after requireTenant + requireTenantPathAccess, so :id is the caller's own tenant here.
 */
const Tenant = require("../models/tenant.model");

const CODE = "TENANT_LIFECYCLE_PLATFORM_ONLY";
const refuse = (res) => res.status(403).json({ error: { message: "Tenant lifecycle changes are platform-only", code: CODE, status: 403 } });
const log = (req, reason) => console.warn("[tenant-lifecycle]", JSON.stringify({
  event: "tenant.lifecycle.refused",
  reason,
  route: `${req.method} ${(req.baseUrl || "") + (req.route?.path || "")}`,
  actorTenantId: req.ctx?.tenantId || null,
  correlationId: req.correlationId || req.headers?.["x-correlation-id"] || null,
}));

function refuseTenantLifecycle(req, res) {
  log(req, "lifecycle-route");
  return refuse(res);
}

async function refuseTenantLifecycleFields(req, res, next) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (Object.keys(body).some((k) => k.startsWith("$"))) {
    log(req, "update-operator");
    return refuse(res);
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has("isActive") && !has("status")) return next();
  let stored;
  try {
    stored = await Tenant.findOne({ _id: req.params.id }).select({ isActive: 1, status: 1 }).lean();
  } catch (err) {
    log(req, "lookup-error");
    return refuse(res); // fail closed
  }
  if (!stored) return next(); // the controller answers 404
  const changesActive = has("isActive") && body.isActive !== (stored.isActive !== false);
  const changesStatus = has("status") && body.status !== (stored.status || "PENDING");
  if (changesActive || changesStatus) {
    log(req, "lifecycle-field");
    return refuse(res);
  }
  return next();
}

module.exports = { refuseTenantLifecycle, refuseTenantLifecycleFields, TENANT_LIFECYCLE_CODE: CODE };
