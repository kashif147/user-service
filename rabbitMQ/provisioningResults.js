/**
 * Phase B / P4 - user-service consumer for the owning services' provisioning step RESULTS
 * (tenant.provisioning.step.completed.v1 / .failed.v1). IMPLEMENTED, NOT ACTIVE: bound only when
 * PROVISIONING_RESULT_CONSUMER=on (default off; any other value = off).
 *
 * Adds the transport check (AMQP x-tenant-id header = envelope tenantId) and delegates everything else to the
 * reviewed services/provisioningOrchestrator.handleStepResultEvent (run exists, v2 key of that run, target tenant,
 * expected current step, current attempt, manifest digest = the step's PlatformTemplate pin, order, duplicate vs
 * conflict) which records via the existing compare-and-set transition. Refusals are acknowledged (never
 * redelivered); only infrastructure errors throw (the middleware redelivers).
 */
const orchestrator = require("../services/provisioningOrchestrator");

const QUEUE = "user.provisioning.results";
const { COMPLETED, FAILED } = orchestrator.EVENT_TYPES;
const log = (event, extra) => console.info("[provisioning-results]", JSON.stringify({ event, ...extra }));

async function handleProvisioningResultMessage(payload, context = {}) {
  const eventType = payload && payload.eventType;
  const header = context.headers ? context.headers["x-tenant-id"] : undefined;
  if (!payload || typeof payload.tenantId !== "string" || header !== payload.tenantId) {
    log("provisioning.result.refused", { code: orchestrator.RESULT_CODES.TENANT_MISMATCH, eventType: eventType || null });
    return { outcome: "refused", code: orchestrator.RESULT_CODES.TENANT_MISMATCH };
  }
  const r = await orchestrator.handleStepResultEvent({ eventType, envelope: payload });
  log(`provisioning.result.${r.outcome}`, { code: r.code, eventType, eventId: typeof payload.eventId === "string" ? payload.eventId.slice(0, 64) : null });
  return r;
}

async function setupProvisioningResultConsumer(consumer) {
  if (process.env.PROVISIONING_RESULT_CONSUMER !== "on") return { bound: false };
  await consumer.createQueue(QUEUE, { durable: true });
  await consumer.bindQueue(QUEUE, "provisioning.events", [COMPLETED, FAILED]);
  consumer.registerHandler(COMPLETED, (payload, context) => handleProvisioningResultMessage(payload, context));
  consumer.registerHandler(FAILED, (payload, context) => handleProvisioningResultMessage(payload, context));
  await consumer.consume(QUEUE, { prefetch: 1 });
  console.log("✅ Provisioning result consumer ready:", QUEUE);
  return { bound: true, queue: QUEUE };
}

module.exports = { handleProvisioningResultMessage, setupProvisioningResultConsumer, QUEUE };
