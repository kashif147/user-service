/**
 * Phase B / Z4: durable audit events for meaningful platform-auth decisions (audit-service stores them with
 * actor_scope = platform; see audit-service src/helpers/auditContext.js).
 *
 * Published (user.events exchange, audit-service queue audit.platform.events):
 *   platform.claim.decision.v1 - a CRM sign-in resolved to a REAL PlatformPrincipal: claim issued, or refused
 *                                because the principal is disabled / bound to another directory.
 *                                (Every ordinary sign-in is "not_principal": log only, never audited.)
 *   platform.authz.decision.v1 - an ENFORCED platform authorization decision (allow or 403 deny) - in Z4
 *                                only the DEV probe. Shadow observers stay log-only (high volume, no effect).
 * Principal create / disable / enable / set-permissions run in the operator script, which has no trusted
 * tenant to own an audit row (A1); the principal's append-only `changes` history records them (Z5 decision).
 *
 * Context: actorScope "platform", actorTenantId null (a platform actor's authority never comes from a tenant),
 * targetTenantId null (no Z4 route targets a tenant), loginTenantId = the trusted tenant the event happened in
 * (context only). The envelope tenant (the row's A1 owner) is that same trusted request tenant.
 * Payload: decision fields and ids only - never a token, oid, issuer, email or name.
 * Fire-and-forget: a publish failure is logged and never changes the sign-in or the authorization result.
 */
// Required lazily: the RabbitMQ module pulls in its listeners, which must not load with every middleware.
const rabbit = () => require("../rabbitMQ");
const EVENTS = Object.freeze({
  PLATFORM_CLAIM_DECISION: "platform.claim.decision.v1",
  PLATFORM_AUTHZ_DECISION: "platform.authz.decision.v1",
});

const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;

function platformAuditContext(tenantId) {
  return { actorScope: "platform", actorTenantId: null, targetTenantId: null, loginTenantId: tenantId };
}

function publish(eventType, tenantId, data, correlationId) {
  const tenant = tenantId == null ? "" : String(tenantId);
  if (!INTERNAL_TENANT_ID.test(tenant)) {
    // No trusted tenant to own the row: never fabricate one.
    console.warn("[platform-audit]", JSON.stringify({ event: "platform.audit.skipped", eventType, reason: "no_trusted_tenant" }));
    return;
  }
  Promise.resolve()
    .then(() =>
      rabbit().publishDomainEvent(eventType, data, {
        tenantId: tenant,
        ...(correlationId ? { correlationId: String(correlationId) } : {}),
        auditContext: platformAuditContext(tenant),
      })
    )
    .catch((err) => {
      console.warn("[platform-audit]", JSON.stringify({ event: "platform.audit.publish_failed", eventType, error: err && err.name ? err.name : "Error" }));
    });
}

/** CRM sign-in claim decision for a real principal (issued / disabled / identity_mismatch). */
function auditClaimDecision({ tenantId, userId, principalId, decision, mode, rev, permissionCount, mfa }) {
  publish(EVENTS.PLATFORM_CLAIM_DECISION, tenantId, {
    decision,
    mode,
    principalId: principalId ? String(principalId) : null,
    actorUserId: userId ? String(userId) : null,
    ...(rev !== undefined ? { currentRev: rev } : {}),
    ...(permissionCount !== undefined ? { permissionCount } : {}),
    ...(mfa !== undefined ? { mfa } : {}),
  });
}

/** An enforced platform authorization decision (allow / deny). */
function auditAuthzDecision({ req, permission, mode, decision }) {
  publish(
    EVENTS.PLATFORM_AUTHZ_DECISION,
    req?.ctx?.tenantId,
    {
      allowed: decision.allowed === true,
      reason: decision.reason,
      permission,
      mode,
      principalId: decision.pid ? String(decision.pid) : null,
      actorUserId: req?.ctx?.userId ? String(req.ctx.userId) : null,
      tokenRev: decision.tokenRev ?? null,
      currentRev: decision.currentRev ?? null,
      revMatch: decision.revMatch ?? null,
      route: `${req?.method} ${(req?.baseUrl || "") + (req?.route?.path || "")}`,
    },
    req?.correlationId || req?.headers?.["x-correlation-id"]
  );
}

module.exports = { auditClaimDecision, auditAuthzDecision, platformAuditContext, EVENTS };
