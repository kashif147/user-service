/**
 * Phase B / P3 prerequisite: the provisioning orchestrator's two state transitions. NOT wired to any route,
 * consumer or timer in this change - P3 activation does that after review (no distributed execution yet).
 *
 * requestNextStep({ runId })
 *   In ONE MongoDB transaction: the next pending step of an open v2 run -> "running" (attempts + 1, startedAt),
 *   run -> "running", history "step-requested", AND the outbox row for tenant.provisioning.step.requested.v1
 *   (deterministic eventId). Either both commit or neither does. If a step is already running (requested, no
 *   result yet) nothing is written and its existing outbox event is returned: a repeated / retried / restarted
 *   command is a no-op, never a second logical event. Legacy v1 runs are refused (LEGACY_STEP_KEY_VERSION).
 *
 * handleStepResultEvent({ eventType, envelope })
 *   Validates a tenant.provisioning.step.completed.v1 / .failed.v1 from an owning service and records it
 *   (provisioningRunService.recordStepResult, compare-and-set). Fails closed - nothing recorded - on: unknown /
 *   malformed event, envelope tenant != event tenant != run tenant (TENANT_MISMATCH), unknown run, non-canonical
 *   or foreign step key, service / component mismatch, stale attempt, a step that was never requested
 *   (out-of-order completion), a conflicting result for an already finished step. A duplicate delivery of the
 *   same result is acknowledged as DUPLICATE (no write). A completion whose manifest digest differs from the
 *   step's pinned digest is recorded as a FAILED step (MANIFEST_DIGEST_MISMATCH) - never as success.
 *   Returns { outcome: "recorded" | "duplicate" | "refused", code } - the consumer acks every outcome (a refused
 *   event is not retried); only infrastructure errors throw (redelivery).
 */
const mongoose = require("mongoose");
const { AppError } = require("../errors/AppError");
const ProvisioningRun = require("../models/provisioningRun.model");
const ProvisioningOutbox = require("../models/provisioningOutbox.model");
const { getComponent } = require("../constants/provisioningComponents");
const { STEP_KEY_VERSION, parseStepKey, eventIdFor } = require("../constants/provisioningStepKeys");
const runs = require("./provisioningRunService");
const { auditProvisioningStep } = require("./platformAuditService");

const REQUESTED = "tenant.provisioning.step.requested.v1";
const COMPLETED = "tenant.provisioning.step.completed.v1";
const FAILED = "tenant.provisioning.step.failed.v1";
const ORCHESTRATOR = Object.freeze({ scope: "system", principalId: null, actorId: "platform:provisioning" });
const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HISTORY_CAP = 200;
const { OPEN_STATUSES, FAILURE_CODES } = ProvisioningRun;

const RESULT_CODES = Object.freeze({
  MALFORMED_EVENT: "MALFORMED_EVENT",
  TENANT_MISMATCH: "TENANT_MISMATCH",
  UNKNOWN_RUN: "UNKNOWN_RUN",
  INVALID_STEP_KEY: "INVALID_STEP_KEY",
  STEP_MISMATCH: "STEP_MISMATCH",
  STALE_ATTEMPT: "STALE_ATTEMPT",
  STEP_NOT_REQUESTED: "STEP_NOT_REQUESTED",
  RESULT_CONFLICT: "RESULT_CONFLICT",
  LEGACY_STEP_KEY_VERSION: "LEGACY_STEP_KEY_VERSION",
  DUPLICATE: "DUPLICATE",
  MANIFEST_DIGEST_MISMATCH: "MANIFEST_DIGEST_MISMATCH",
  RECORDED: "RECORDED",
});
const err = (status, code, message) => new AppError(message, status, code);

function requestPayload(run, step) {
  const parsed = parseStepKey(step.key);
  return {
    runId: run.runId,
    tenantId: run.tenantId,
    stepKey: step.key,
    stepKeyVersion: STEP_KEY_VERSION,
    service: step.service,
    component: step.component,
    action: parsed.action,
    manifestVersion: step.version,
    manifestSha256: step.manifestSha256,
    attempt: run.attempt,
    templateKey: run.templateKey,
    templateVersion: run.templateVersion,
  };
}

async function requestNextStep({ runId }, { startSession = () => mongoose.startSession() } = {}) {
  const session = await startSession();
  let out;
  try {
    await session.withTransaction(async () => {
      const run = await ProvisioningRun.findOne({ runId: String(runId) }).session(session).lean();
      if (!run) throw err(404, runs.CODES.RUN_NOT_FOUND, "Provisioning run not found");
      if (run.stepKeyVersion !== STEP_KEY_VERSION) throw err(409, runs.CODES.LEGACY_STEP_KEY_VERSION, "Run predates the canonical step key; it is history only");
      if (!OPEN_STATUSES.includes(run.status)) throw err(409, runs.CODES.RUN_STATE_CONFLICT, "Run is not open");
      const running = run.steps.find((s) => s.status === "running");
      if (running) {
        const ev = await ProvisioningOutbox.findOne({ eventType: REQUESTED, stepKey: running.key, attempt: run.attempt }).session(session).lean();
        out = { requested: false, existing: true, stepKey: running.key, eventId: ev ? ev.eventId : null, tenantId: run.tenantId };
        return;
      }
      const next = [...run.steps].sort((a, b) => a.order - b.order).find((s) => s.status === "pending");
      if (!next) throw err(409, runs.CODES.RUN_STATE_CONFLICT, "No pending step");
      const now = new Date();
      const upd = await ProvisioningRun.updateOne(
        { runId: run.runId, tenantId: run.tenantId, status: run.status, attempt: run.attempt, steps: { $elemMatch: { key: next.key, status: "pending" } } },
        {
          $set: { status: "running", "steps.$[s].status": "running", "steps.$[s].startedAt": now, "steps.$[s].completedAt": null },
          $inc: { "steps.$[s].attempts": 1 },
          $push: { history: { $each: [{ at: now, action: "step-requested", actor: ORCHESTRATOR, fromStatus: run.status, toStatus: "running", step: next.key, attempt: run.attempt }], $slice: -HISTORY_CAP } },
        },
        { arrayFilters: [{ "s.key": next.key, "s.status": "pending" }], session, runValidators: true }
      );
      if (upd.modifiedCount !== 1) throw err(409, runs.CODES.RUN_STATE_CONFLICT, "Concurrent change: step not requested");
      const eventId = eventIdFor(REQUESTED, next.key, run.attempt);
      await ProvisioningOutbox.create(
        [{ eventId, eventType: REQUESTED, runId: run.runId, tenantId: run.tenantId, stepKey: next.key, attempt: run.attempt, payload: requestPayload(run, next), status: "pending", nextAttemptAt: now }],
        { session }
      );
      out = { requested: true, existing: false, stepKey: next.key, eventId, tenantId: run.tenantId };
    });
  } finally {
    await session.endSession();
  }
  if (out.requested) auditProvisioningStep({ action: "PROVISIONING_STEP_REQUESTED", result: "success", tenantId: out.tenantId, runId: String(runId), stepKey: out.stepKey });
  return out;
}

const refused = (code, extra = {}) => ({ outcome: "refused", code, ...extra });

async function handleStepResultEvent({ eventType, envelope }) {
  if (eventType !== COMPLETED && eventType !== FAILED) return refused(RESULT_CODES.MALFORMED_EVENT);
  const d = envelope && envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data : null;
  if (!d || typeof envelope.eventId !== "string") return refused(RESULT_CODES.MALFORMED_EVENT);
  const envTenant = envelope.tenantId;
  if (typeof envTenant !== "string" || !INTERNAL_TENANT_ID.test(envTenant)) return refused(RESULT_CODES.TENANT_MISMATCH);
  if (d.tenantId !== envTenant) return refused(RESULT_CODES.TENANT_MISMATCH);
  const key = parseStepKey(d.stepKey);
  if (!key || key.version !== STEP_KEY_VERSION || key.runId !== d.runId) return refused(RESULT_CODES.INVALID_STEP_KEY);
  if (!Number.isInteger(d.attempt) || d.attempt < 1 || typeof d.manifestSha256 !== "string" || !SHA256.test(d.manifestSha256)) return refused(RESULT_CODES.MALFORMED_EVENT);
  if (eventType === COMPLETED && ![d.insertedCount, d.skippedCount].every((n) => Number.isInteger(n) && n >= 0)) return refused(RESULT_CODES.MALFORMED_EVENT);
  if (eventType === FAILED && !FAILURE_CODES.includes(d.failureCode)) return refused(RESULT_CODES.MALFORMED_EVENT);

  const run = await ProvisioningRun.findOne({ runId: d.runId }).lean();
  if (!run) return refused(RESULT_CODES.UNKNOWN_RUN);
  const audit = (action, result, reason, extra = {}) => auditProvisioningStep({ action, result, reason, tenantId: run.tenantId, runId: run.runId, stepKey: d.stepKey, attempt: d.attempt, ...extra });
  if (run.tenantId !== envTenant) return refused(RESULT_CODES.TENANT_MISMATCH); // never audited against the claimed tenant
  if (run.stepKeyVersion !== STEP_KEY_VERSION) return refused(RESULT_CODES.LEGACY_STEP_KEY_VERSION);
  const step = run.steps.find((s) => s.key === d.stepKey);
  const reg = step && getComponent(step.component);
  if (!step || !reg || `${key.service}:${key.component}` !== step.component || d.service !== step.service) {
    audit("PROVISIONING_STEP_RESULT_REFUSED", "failure", "step_mismatch");
    return refused(RESULT_CODES.STEP_MISMATCH);
  }
  if (d.attempt !== run.attempt) {
    audit("PROVISIONING_STEP_RESULT_REFUSED", "failure", "stale_attempt");
    return refused(RESULT_CODES.STALE_ATTEMPT);
  }
  const wanted = eventType === COMPLETED ? "succeeded" : "failed";
  if (step.status === "succeeded" || step.status === "failed") {
    // redelivery of the same result is a no-op; a different result for a finished step is refused
    if (step.status === wanted || (step.status === "failed" && step.failureCode === RESULT_CODES.MANIFEST_DIGEST_MISMATCH)) return { outcome: "duplicate", code: RESULT_CODES.DUPLICATE };
    audit("PROVISIONING_STEP_RESULT_REFUSED", "failure", "result_conflict");
    return refused(RESULT_CODES.RESULT_CONFLICT);
  }
  if (step.status !== "running" || !OPEN_STATUSES.includes(run.status)) {
    audit("PROVISIONING_STEP_RESULT_REFUSED", "failure", "step_not_requested");
    return refused(RESULT_CODES.STEP_NOT_REQUESTED);
  }
  let result;
  let code = RESULT_CODES.RECORDED;
  if (d.manifestSha256 !== step.manifestSha256) {
    // the service ran (or claims) a manifest other than the pinned one: the step fails, deterministically
    result = { status: "failed", failureCode: "MANIFEST_DIGEST_MISMATCH" };
    code = RESULT_CODES.MANIFEST_DIGEST_MISMATCH;
  } else if (eventType === COMPLETED) {
    result = { status: "succeeded", insertedCount: d.insertedCount, skippedCount: d.skippedCount };
  } else {
    result = { status: "failed", failureCode: d.failureCode };
  }
  let after;
  try {
    after = await runs.recordStepResult({ runId: run.runId, tenantId: run.tenantId, stepKey: d.stepKey, result, actor: ORCHESTRATOR, expectedAttempt: d.attempt });
  } catch (e) {
    if (e instanceof AppError) {
      audit("PROVISIONING_STEP_RESULT_REFUSED", "failure", String(e.code).toLowerCase());
      return refused(e.code === runs.CODES.STEP_OUT_OF_ORDER ? "STEP_OUT_OF_ORDER" : e.code === runs.CODES.STALE_ATTEMPT ? RESULT_CODES.STALE_ATTEMPT : RESULT_CODES.RESULT_CONFLICT);
    }
    throw e;
  }
  const s = after.steps.find((x) => x.key === d.stepKey);
  audit(result.status === "succeeded" ? "PROVISIONING_STEP_SUCCEEDED" : "PROVISIONING_STEP_FAILED", result.status === "succeeded" ? "success" : "failure", result.failureCode ? result.failureCode.toLowerCase() : undefined, {
    stepStatus: s.status, runStatus: after.status, insertedCount: s.insertedCount, skippedCount: s.skippedCount, failureCode: s.failureCode, component: step.component, manifestVersion: step.version,
  });
  return { outcome: "recorded", code, runStatus: after.status, stepStatus: s.status };
}

module.exports = { requestNextStep, handleStepResultEvent, RESULT_CODES, EVENT_TYPES: Object.freeze({ REQUESTED, COMPLETED, FAILED }), ORCHESTRATOR, requestPayload };
