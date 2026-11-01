/**
 * Phase B / Z4-Z5: durable audit events for platform / system security actions.
 *
 * Z5 storage rule (owner decision): every platform / system security event is stored by audit-service in
 * platform_audit_logs (src/rabbitMQ/platformAudit.js there) - a table with NO tenant owner. These events are
 * therefore published WITHOUT an envelope tenant: the tenant the caller signed in to is context only
 * (auditContext.loginTenantId), never an owner and never visibility. A tenant-visible copy exists only for a
 * successful tenant creation (tenant.lifecycle.created.v1, owned by the NEW tenant, no platform detail).
 * Historical boundary: before Z5 (DEV rows 173-178) these rows went to audit_logs under the sign-in tenant;
 * they stay where they are.
 *
 * Published (user.events exchange):
 *   platform.claim.decision.v1        a CRM sign-in resolved to a REAL principal (issued / refused).
 *                                     Ordinary sign-ins ("not_principal") are log only.
 *   platform.authz.decision.v1        an ENFORCED platform authorization decision on a migrated platform route
 *                                     (allow or deny; shadow observers and 401s are log only).
 *   platform.tenant.created.v1        authoritative record of a successful platform tenant creation
 *                                     (target = the new tenant)  +  tenant.lifecycle.created.v1 (tenant copy).
 *   platform.tenant.create.failed.v1  an authorized tenant creation that failed (no tenant exists: target NULL).
 *   platform.principal.changed.v1     a principal-admin script mutation (system actor platform:principal-admin).
 *   platform.tenant.admin.changed.v1  (Z6) outcome of a cross-tenant tenant-administration mutation by a platform
 *                                     principal (target = the route tenant)  +, for approved lifecycle /
 *                                     configuration changes only, tenant.lifecycle.changed.v1 (copy owned by the
 *                                     target tenant: action + section / status values / connection id, nothing else).
 *                                     Cross-tenant reads and denials are platform.authz.decision.v1 with the target.
 *   platform.provisioning.run.changed.v1        (P1) a provisioning-run action by a platform principal holding
 *                                     platform:provisioning:admin (target = the run's tenant): ids, statuses, counts.
 *   platform.provisioning.template.published.v1 (P1) scripts/platform-template.js publish / retire (system actor
 *                                     platform:provisioning, no tenant).
 *
 * Actor context:
 *   platform  a PlatformPrincipal is identified (pid): actorTenantId null, targetTenantId null unless the
 *             action has a real target tenant.
 *   tenant    a caller with no usable platform claim (legacy SU with "*", ASU, ordinary users) DENIED a
 *             platform action: actorTenantId = its own trusted tenant (truthful - never relabelled platform).
 *   system    the principal-admin script (reserved actor id; --by / --approval are operator-SUPPLIED labels,
 *             not authenticated identity).
 * Payload: decision fields and ids only - never a token, oid, issuer, email or name.
 * Request-path events are fire-and-forget (a publish failure never changes a response); the admin script
 * awaits its event (the process exits right after).
 */
// Required lazily: the RabbitMQ module pulls in its listeners, which must not load with every middleware.
const rabbit = () => require("../rabbitMQ");

const EVENTS = Object.freeze({
  PLATFORM_CLAIM_DECISION: "platform.claim.decision.v1",
  PLATFORM_AUTHZ_DECISION: "platform.authz.decision.v1",
  PLATFORM_TENANT_CREATED: "platform.tenant.created.v1",
  PLATFORM_TENANT_CREATE_FAILED: "platform.tenant.create.failed.v1",
  PLATFORM_PRINCIPAL_CHANGED: "platform.principal.changed.v1",
  TENANT_LIFECYCLE_CREATED: "tenant.lifecycle.created.v1",
  PLATFORM_TENANT_ADMIN_CHANGED: "platform.tenant.admin.changed.v1",
  TENANT_LIFECYCLE_CHANGED: "tenant.lifecycle.changed.v1",
  PLATFORM_PROVISIONING_RUN_CHANGED: "platform.provisioning.run.changed.v1",
  PLATFORM_PROVISIONING_TEMPLATE_PUBLISHED: "platform.provisioning.template.published.v1",
});
const PROVISIONING_PERMISSION = "platform:provisioning:admin";
const PROVISIONING_ACTOR = "platform:provisioning";
// Phase B / P1: provisioning-run audit actions (platform actor, target = the run's tenant).
const PROVISIONING_RUN_ACTIONS = new Set(["PROVISIONING_RUN_CREATED", "PROVISIONING_RUN_REQUESTED_EXISTING", "PROVISIONING_RUN_RESUMED", "PROVISIONING_RUN_REFUSED"]);
const PRINCIPAL_ADMIN_ACTOR = "platform:principal-admin";
const TENANT_CREATE_PERMISSION = "platform:tenant:create";

const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;
const tenantOrNull = (v) => (v != null && INTERNAL_TENANT_ID.test(String(v)) ? String(v) : null);
const idOrNull = (v) => (v ? String(v) : null);

function platformAuditContext(loginTenantId, targetTenantId = null) {
  return { actorScope: "platform", actorTenantId: null, targetTenantId: tenantOrNull(targetTenantId), loginTenantId: tenantOrNull(loginTenantId) };
}

function tenantAuditContext(tenantId) {
  return { actorScope: "tenant", actorTenantId: tenantId, targetTenantId: null };
}

function systemAuditContext() {
  return { actorScope: "system", actorTenantId: null, targetTenantId: null };
}

const warn = (event, extra) => console.warn("[platform-audit]", JSON.stringify({ event, ...extra }));

/** Publish one audit event. Resolves true/false; never rejects. envelopeTenantId only for the tenant copy. */
function publish(eventType, data, { auditContext, correlationId, envelopeTenantId } = {}) {
  return Promise.resolve()
    .then(() =>
      rabbit().publishDomainEvent(eventType, data, {
        ...(envelopeTenantId ? { tenantId: envelopeTenantId } : {}),
        ...(correlationId ? { correlationId: String(correlationId) } : {}),
        auditContext,
      })
    )
    .then((ok) => {
      if (ok === false) warn("platform.audit.publish_failed", { eventType, error: "not_published" });
      return ok !== false;
    })
    .catch((err) => {
      warn("platform.audit.publish_failed", { eventType, error: err && err.name ? err.name : "Error" });
      return false;
    });
}

const correlationOf = (req) => req?.correlationId || req?.headers?.["x-correlation-id"];
const routeOf = (req) => `${req?.method} ${(req?.baseUrl || "") + (req?.route?.path || "")}`;

/** CRM sign-in claim decision for a real principal (issued / disabled / identity_mismatch). */
function auditClaimDecision({ tenantId, userId, principalId, decision, mode, rev, permissionCount, mfa }) {
  if (!principalId) return;
  publish(EVENTS.PLATFORM_CLAIM_DECISION, {
    decision,
    mode,
    principalId: String(principalId),
    actorUserId: idOrNull(userId),
    ...(rev !== undefined ? { currentRev: rev } : {}),
    ...(permissionCount !== undefined ? { permissionCount } : {}),
    ...(mfa !== undefined ? { mfa } : {}),
  }, { auditContext: platformAuditContext(tenantId) });
}

/**
 * An enforced platform authorization decision (allow / deny). `status` = the HTTP status the route answered
 * (e.g. 423 when a valid platform actor then hits the A14 freeze, or a tenant actor is refused while frozen).
 */
function auditAuthzDecision({ req, permission, mode, decision, status, targetTenantId = null }) {
  const data = {
    allowed: decision.allowed === true,
    reason: decision.reason,
    permission,
    mode,
    principalId: decision.pid ? String(decision.pid) : null,
    actorUserId: idOrNull(req?.ctx?.userId),
    tokenRev: decision.tokenRev ?? null,
    currentRev: decision.currentRev ?? null,
    revMatch: decision.revMatch ?? null,
    route: routeOf(req),
    ...(status !== undefined ? { status } : {}),
  };
  let auditContext;
  if (decision.pid) {
    auditContext = platformAuditContext(req?.ctx?.tenantId, targetTenantId);
  } else {
    const tenant = tenantOrNull(req?.ctx?.tenantId);
    if (!tenant || decision.allowed === true) {
      // No trusted tenant to name the tenant actor (or an impossible tenant-actor allow): never fabricate.
      warn("platform.audit.skipped", { eventType: EVENTS.PLATFORM_AUTHZ_DECISION, reason: "no_trusted_tenant" });
      return;
    }
    auditContext = tenantAuditContext(tenant);
  }
  publish(EVENTS.PLATFORM_AUTHZ_DECISION, data, { auditContext, correlationId: correlationOf(req) });
}

/** A successful platform tenant creation: authoritative platform record + the new tenant's lifecycle copy. */
function auditTenantCreated({ req, tenantId }) {
  const newTenant = tenantOrNull(tenantId);
  if (!newTenant || !req?.platform?.pid) {
    warn("platform.audit.skipped", { eventType: EVENTS.PLATFORM_TENANT_CREATED, reason: "no_platform_actor_or_tenant" });
    return;
  }
  const correlationId = correlationOf(req);
  publish(EVENTS.PLATFORM_TENANT_CREATED, {
    principalId: String(req.platform.pid),
    actorUserId: idOrNull(req.ctx?.userId),
    tenantId: newTenant,
    permission: TENANT_CREATE_PERMISSION,
    route: routeOf(req),
  }, { auditContext: platformAuditContext(req.ctx?.tenantId, newTenant), correlationId });
  // Tenant copy: owned by the new tenant; no principal, operator, sign-in tenant or permission detail.
  publish(EVENTS.TENANT_LIFECYCLE_CREATED, { tenantId: newTenant }, {
    envelopeTenantId: newTenant,
    auditContext: { actorScope: "platform", actorTenantId: null, targetTenantId: newTenant },
    correlationId,
  });
}

/** An authorized platform tenant creation that failed: platform record only (no tenant exists). */
function auditTenantCreateFailed({ req, reason, status }) {
  if (!req?.platform?.pid) return;
  publish(EVENTS.PLATFORM_TENANT_CREATE_FAILED, {
    principalId: String(req.platform.pid),
    actorUserId: idOrNull(req.ctx?.userId),
    permission: TENANT_CREATE_PERMISSION,
    reason,
    status,
    route: routeOf(req),
  }, { auditContext: platformAuditContext(req.ctx?.tenantId), correlationId: correlationOf(req) });
}

// Z6 tenant-copy rule (owner brief §14): only material lifecycle / configuration changes are copied to the
// target tenant's own history. Reads, denials, connect-start, test and tenant delete (a deleted tenant can no
// longer sign anyone in to read it) are platform-only.
const TENANT_COPY_ACTIONS = new Set([
  "TENANT_UPDATED", "TENANT_SUSPENDED", "TENANT_REACTIVATED", "TENANT_STATUS_CHANGED",
  "AUTH_CONNECTION_ADDED", "AUTH_CONNECTION_UPDATED", "AUTH_CONNECTION_REMOVED",
  "AUTH_CONNECTION_CONNECTED", "AUTH_CONNECTION_DISCONNECTED",
]);
const OBJECT_ID = /^[0-9a-f]{24}$/;

/**
 * Z6: the outcome of a cross-tenant tenant-administration mutation (req.platform set by
 * middlewares/platformTenantAdmin.js). result success -> authoritative platform record + (approved actions only)
 * the target tenant's copy; failure -> platform record only. Never the request body.
 */
function auditTenantAdminChange({ req, action, result, status, reason, section, connectionId, fromStatus, toStatus }) {
  const target = tenantOrNull(req?.platform?.targetTenantId);
  if (!target || !req?.platform?.pid) {
    warn("platform.audit.skipped", { eventType: EVENTS.PLATFORM_TENANT_ADMIN_CHANGED, reason: "no_platform_actor_or_target" });
    return;
  }
  const conn = connectionId && OBJECT_ID.test(String(connectionId)) ? String(connectionId) : undefined;
  const safe = {
    ...(section ? { section } : {}),
    ...(conn ? { connectionId: conn } : {}),
    ...(fromStatus ? { fromStatus } : {}),
    ...(toStatus ? { toStatus } : {}),
  };
  const correlationId = correlationOf(req);
  publish(EVENTS.PLATFORM_TENANT_ADMIN_CHANGED, {
    principalId: String(req.platform.pid),
    actorUserId: idOrNull(req.ctx?.userId),
    tenantId: target,
    action,
    permission: req.platform.permission,
    result,
    status,
    ...(reason ? { reason } : {}),
    route: routeOf(req),
    ...safe,
  }, { auditContext: platformAuditContext(req.ctx?.tenantId, target), correlationId });
  if (result !== "success" || !TENANT_COPY_ACTIONS.has(action)) return;
  publish(EVENTS.TENANT_LIFECYCLE_CHANGED, { tenantId: target, action, ...safe }, {
    envelopeTenantId: target,
    auditContext: { actorScope: "platform", actorTenantId: null, targetTenantId: target },
    correlationId,
  });
}

/**
 * A principal-admin script mutation (system actor). Awaitable: resolves true when published.
 * operatorLabel / approvalRef are operator-supplied (--by / --approval), not authenticated identity.
 */
function auditPrincipalChange({ action, result, reason, principalId, status, revision, permissionsAdded, permissionsRemoved, operatorLabel, approvalRef, correlationId }) {
  return publish(EVENTS.PLATFORM_PRINCIPAL_CHANGED, {
    actorId: PRINCIPAL_ADMIN_ACTOR,
    action,
    result,
    ...(reason ? { reason } : {}),
    principalId: idOrNull(principalId),
    ...(status !== undefined ? { status } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(permissionsAdded ? { permissionsAdded } : {}),
    ...(permissionsRemoved ? { permissionsRemoved } : {}),
    operatorLabel,
    approvalRef,
  }, { auditContext: systemAuditContext(), correlationId });
}

/**
 * Phase B / Z9: one tenant's legacy SU -> ASU role migration (scripts/migrate-su-to-asu.js; the reserved system
 * actor platform:migration - audit-service helpers/auditContext.js SYSTEM_ACTORS).
 * A TENANT-owned record (envelope + target = that tenant, actor_scope "system"): counts and status only -
 * no user ids, emails or role permission lists. Awaitable: resolves true when published.
 */
const ROLE_MIGRATION_ACTOR = "platform:migration";
function auditTenantRoleMigration({ tenantId, outcome, affectedUsers, affectedConnections, permissionsAdded, suRolesRetired, runId, correlationId }) {
  const target = idOrNull(tenantId);
  if (!target) return Promise.resolve(false);
  return publish(EVENTS.TENANT_LIFECYCLE_CHANGED, {
    tenantId: target,
    action: "TENANT_ROLE_MIGRATED",
    actorId: ROLE_MIGRATION_ACTOR,
    fromRole: "SU",
    toRole: "ASU",
    outcome,
    affectedUsers,
    affectedConnections,
    permissionsAdded,
    suRolesRetired,
    runId,
  }, {
    envelopeTenantId: target,
    auditContext: { actorScope: "system", actorTenantId: null, targetTenantId: target },
    correlationId: correlationId || runId,
  });
}

/**
 * Phase B / P1: a provisioning-run control-plane action by a platform principal (req.platform set by
 * requirePlatformPermission("platform:provisioning:admin")): create / existing-run request / resume / refusal.
 * Platform record only (platform_audit_logs), target = the run's tenant (null when the request named no
 * existing tenant). Ids, statuses and counts only. Step results (P3/P4, system actor) are not emitted here yet.
 */
function auditProvisioningRun({ req, action, result, reason, run, tenantId }) {
  if (!req?.platform?.pid || !PROVISIONING_RUN_ACTIONS.has(action)) {
    warn("platform.audit.skipped", { eventType: EVENTS.PLATFORM_PROVISIONING_RUN_CHANGED, reason: "no_platform_actor_or_action" });
    return;
  }
  const target = tenantOrNull(run ? run.tenantId : tenantId);
  const steps = run && Array.isArray(run.steps) ? run.steps : [];
  const sum = (k) => steps.reduce((n, s) => n + (Number.isInteger(s[k]) ? s[k] : 0), 0);
  publish(EVENTS.PLATFORM_PROVISIONING_RUN_CHANGED, {
    principalId: String(req.platform.pid),
    actorUserId: idOrNull(req.ctx?.userId),
    ...(target ? { tenantId: target } : {}),
    action,
    permission: PROVISIONING_PERMISSION,
    result,
    ...(reason ? { reason } : {}),
    route: routeOf(req),
    ...(run ? {
      runId: run.runId,
      templateKey: run.templateKey,
      templateVersion: run.templateVersion,
      runStatus: run.status,
      attempt: run.attempt,
      stepCount: steps.length,
      stepsSucceeded: steps.filter((s) => s.status === "succeeded").length,
      insertedCount: sum("insertedCount"),
      skippedCount: sum("skippedCount"),
    } : {}),
  }, { auditContext: platformAuditContext(req.ctx?.tenantId, target), correlationId: correlationOf(req) });
}

/**
 * Phase B / P1: scripts/platform-template.js publish / retire (reserved system actor platform:provisioning;
 * --by / --approval are operator-SUPPLIED labels). No tenant: a template belongs to none. Awaitable.
 */
function auditTemplatePublished({ action, result, reason, templateKey, templateVersion, contentHash, componentCount, operatorLabel, approvalRef, correlationId }) {
  return publish(EVENTS.PLATFORM_PROVISIONING_TEMPLATE_PUBLISHED, {
    actorId: PROVISIONING_ACTOR,
    action,
    result,
    ...(reason ? { reason } : {}),
    templateKey,
    templateVersion,
    ...(contentHash ? { contentHash } : {}),
    ...(componentCount !== undefined ? { componentCount } : {}),
    operatorLabel,
    approvalRef,
  }, { auditContext: systemAuditContext(), correlationId });
}

module.exports = {
  auditProvisioningRun,
  auditTemplatePublished,
  PROVISIONING_RUN_ACTIONS,
  auditTenantRoleMigration,
  ROLE_MIGRATION_ACTOR,
  auditClaimDecision,
  auditAuthzDecision,
  auditTenantCreated,
  auditTenantCreateFailed,
  auditPrincipalChange,
  auditTenantAdminChange,
  TENANT_COPY_ACTIONS,
  platformAuditContext,
  tenantAuditContext,
  systemAuditContext,
  EVENTS,
  PRINCIPAL_ADMIN_ACTOR,
};
