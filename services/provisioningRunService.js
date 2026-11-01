/**
 * Phase B / P1: the provisioning control plane - ProvisioningRun lifecycle over published PlatformTemplates.
 *
 * Boundary: P1 records and plans; it dispatches NOTHING. There is no code path from here to another service
 * (no HTTP client, no event publish other than the platform audit). Step results arrive in P3/P4 from the
 * transactional outbox replies through recordStepResult; until then every planned step stays "pending".
 *
 * Ownership: the target is the tenant's INTERNAL id, given explicitly and checked to exist by _id. It is never
 * resolved from an organisation code, an Entra tid, an email domain, the caller's tenant or an env default.
 * Nothing here creates users, roles (SU or otherwise) or permissions, and nothing writes another collection.
 *
 * Idempotency:
 *   createOrGetRun  one run per (tenant, template key, version) - an upsert on the unique index; a repeat
 *                   returns the existing run untouched (whatever its state), never a second run.
 *   recordStepResult compare-and-set: only an OPEN step of an OPEN run, and only when every earlier required
 *                   step has succeeded; a terminal step result is never overwritten (409).
 *   resumeRun       failed -> pending (attempt + 1); succeeded steps stay succeeded (skipped on replay), the
 *                   failed / pending ones are re-opened. Any other state -> 409.
 */
const crypto = require("crypto");
const { AppError } = require("../errors/AppError");
const Tenant = require("../models/tenant.model");
const PlatformTemplate = require("../models/platformTemplate.model");
const ProvisioningRun = require("../models/provisioningRun.model");
const { getDefinition, templateContentHash } = require("../constants/platformTemplates");

const { INTERNAL_TENANT_ID, OPEN_STATUSES, FAILURE_CODES } = ProvisioningRun;
const HISTORY_CAP = 200;

const CODES = Object.freeze({
  INTERNAL_TENANT_ID_REQUIRED: "INTERNAL_TENANT_ID_REQUIRED",
  TENANT_NOT_FOUND: "TENANT_NOT_FOUND",
  TEMPLATE_NOT_PUBLISHED: "TEMPLATE_NOT_PUBLISHED",
  TEMPLATE_INTEGRITY: "TEMPLATE_INTEGRITY",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  RUN_STATE_CONFLICT: "RUN_STATE_CONFLICT",
  STEP_NOT_FOUND: "STEP_NOT_FOUND",
  STEP_OUT_OF_ORDER: "STEP_OUT_OF_ORDER",
  INVALID_STEP_RESULT: "INVALID_STEP_RESULT",
});

const err = (status, code, message) => new AppError(message, status, code);

function assertInternalTenantId(tenantId) {
  if (typeof tenantId !== "string" || !INTERNAL_TENANT_ID.test(tenantId)) {
    throw err(400, CODES.INTERNAL_TENANT_ID_REQUIRED, "An internal tenant id is required");
  }
  return tenantId;
}

function platformActor(principalId) {
  if (typeof principalId !== "string" || !/^[0-9a-f]{24}$/.test(principalId)) throw new Error("a platform principal id is required");
  return { scope: "platform", principalId, actorId: null };
}

const historyEntry = (actor, action, fromStatus, toStatus, attempt, step = null) => ({ at: new Date(), action, actor, fromStatus, toStatus, step, attempt });

/** The published template, verified against its reviewed code definition (deterministic content hash). */
async function loadPublishedTemplate(templateKey, templateVersion) {
  const tpl = await PlatformTemplate.findOne({ key: templateKey, version: templateVersion, status: "published" }).lean();
  if (!tpl) throw err(404, CODES.TEMPLATE_NOT_PUBLISHED, "Template version is not published");
  const def = getDefinition(templateKey, templateVersion);
  if (!def || templateContentHash(def) !== tpl.contentHash || templateContentHash(tpl) !== tpl.contentHash) {
    throw err(409, CODES.TEMPLATE_INTEGRITY, "Published template does not match its reviewed definition");
  }
  return tpl;
}

const stepKey = (tenantId, tpl, c) => `${tenantId}:${tpl.key}@${tpl.version}:${c.service}:${c.component}`;

function planSteps(tenantId, tpl) {
  return [...tpl.components]
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      order: c.order,
      key: stepKey(tenantId, tpl, c),
      component: c.component,
      service: c.service,
      version: c.version,
      manifestSha256: c.manifestSha256,
      required: c.required,
      status: "pending",
    }));
}

/**
 * Create the run for (tenant, template version), or return the existing one unchanged.
 * @returns {Promise<{ run: object, created: boolean }>}
 */
async function createOrGetRun({ tenantId, templateKey, templateVersion, principalId }) {
  assertInternalTenantId(tenantId);
  const actor = platformActor(principalId);
  if (typeof templateKey !== "string" || !Number.isInteger(templateVersion)) throw err(400, "BAD_REQUEST", "templateKey and an integer templateVersion are required");
  const tenant = await Tenant.findById(tenantId).select({ _id: 1 }).lean();
  if (!tenant) throw err(404, CODES.TENANT_NOT_FOUND, "Tenant not found");
  const tpl = await loadPublishedTemplate(templateKey, templateVersion);

  // The owner (and template identity) of an inserted run come from the upsert FILTER only - never from $setOnInsert.
  const filter = { tenantId, templateKey, templateVersion };
  const insert = {
    runId: crypto.randomUUID(),
    templateContentHash: tpl.contentHash,
    status: "pending",
    attempt: 1,
    failureCode: null,
    failedStep: null,
    steps: planSteps(tenantId, tpl),
    createdBy: actor,
    history: [historyEntry(actor, "created", null, "pending", 1)],
    completedAt: null,
  };
  // timestamps: false - a repeat request must return the existing run UNTOUCHED (mongoose would otherwise add
  // $set: { updatedAt } to every upsert, found in the P2 DEV run); an inserted run gets both stamps here.
  const now = new Date();
  insert.createdAt = now;
  insert.updatedAt = now;
  let res;
  try {
    res = await ProvisioningRun.findOneAndUpdate(filter, { $setOnInsert: insert }, { upsert: true, new: true, includeResultMetadata: true, runValidators: true, lean: true, timestamps: false });
  } catch (e) {
    if (e && e.code === 11000) {
      const run = await ProvisioningRun.findOne(filter).lean(); // a concurrent create won: same run
      if (run) return { run, created: false };
    }
    throw e;
  }
  const created = !(res.lastErrorObject && res.lastErrorObject.updatedExisting);
  return { run: res.value, created };
}

async function getRun(runId) {
  const run = await ProvisioningRun.findOne({ runId: String(runId) }).lean();
  if (!run) throw err(404, CODES.RUN_NOT_FOUND, "Provisioning run not found");
  return run;
}

async function listRuns({ tenantId } = {}) {
  const q = tenantId === undefined ? {} : { tenantId: assertInternalTenantId(tenantId) };
  return ProvisioningRun.find(q).sort({ createdAt: -1 }).limit(100).lean();
}

/**
 * P3/P4 entry point (no route in P1): record the result of ONE step.
 * result: { status: "succeeded" | "failed", insertedCount, skippedCount, failureCode }
 */
async function recordStepResult({ runId, tenantId, stepKey: key, result, actor }) {
  assertInternalTenantId(tenantId);
  if (!actor || !["platform", "system"].includes(actor.scope)) throw new Error("an actor is required");
  const { status } = result || {};
  if (status !== "succeeded" && status !== "failed") throw err(400, CODES.INVALID_STEP_RESULT, "status must be succeeded or failed");
  const counts = ["insertedCount", "skippedCount"].map((k) => result[k]);
  if (status === "succeeded" && !counts.every((n) => Number.isInteger(n) && n >= 0)) throw err(400, CODES.INVALID_STEP_RESULT, "counts are required");
  if (status === "failed" && !FAILURE_CODES.includes(result.failureCode)) throw err(400, CODES.INVALID_STEP_RESULT, "a known failureCode is required");

  const run = await ProvisioningRun.findOne({ runId, tenantId }).lean();
  if (!run) throw err(404, CODES.RUN_NOT_FOUND, "Provisioning run not found");
  const step = run.steps.find((s) => s.key === key);
  if (!step) throw err(404, CODES.STEP_NOT_FOUND, "Step not found");
  if (!OPEN_STATUSES.includes(run.status) || !OPEN_STATUSES.includes(step.status)) {
    throw err(409, CODES.RUN_STATE_CONFLICT, "Step result already recorded or run not open");
  }
  if (run.steps.some((s) => s.order < step.order && s.required && s.status !== "succeeded")) {
    throw err(409, CODES.STEP_OUT_OF_ORDER, "An earlier required step has not succeeded");
  }

  const now = new Date();
  const set = {
    "steps.$[s].status": status,
    "steps.$[s].insertedCount": status === "succeeded" ? result.insertedCount : null,
    "steps.$[s].skippedCount": status === "succeeded" ? result.skippedCount : null,
    "steps.$[s].failureCode": status === "failed" ? result.failureCode : null,
    "steps.$[s].completedAt": now,
  };
  const last = run.steps.filter((s) => s.key !== key).every((s) => s.status === "succeeded");
  let runStatus = run.status;
  if (status === "failed" && step.required) {
    runStatus = "failed";
    Object.assign(set, { status: "failed", failureCode: result.failureCode, failedStep: key });
  } else if (status === "succeeded" && last) {
    runStatus = "succeeded";
    Object.assign(set, { status: "succeeded", completedAt: now });
  } else if (run.status === "pending") {
    runStatus = "running";
    set.status = "running";
  }
  const action = runStatus === "failed" || runStatus === "succeeded" ? runStatus : "step-recorded";
  const upd = await ProvisioningRun.updateOne(
    { runId, tenantId, status: run.status, attempt: run.attempt, steps: { $elemMatch: { key, status: step.status } } },
    {
      $set: set,
      $inc: { "steps.$[s].attempts": 1 },
      $push: { history: { $each: [historyEntry(actor, action, run.status, runStatus, run.attempt, key)], $slice: -HISTORY_CAP } },
    },
    { arrayFilters: [{ "s.key": key, "s.status": { $in: OPEN_STATUSES } }], runValidators: true }
  );
  if (upd.modifiedCount !== 1) throw err(409, CODES.RUN_STATE_CONFLICT, "Concurrent change: step result not recorded");
  return ProvisioningRun.findOne({ runId, tenantId }).lean();
}

/** A failed run back to pending: completed steps are kept (skipped on replay), the rest re-opened. */
async function resumeRun({ runId, principalId }) {
  const actor = platformActor(principalId);
  const run = await getRun(runId);
  if (run.status !== "failed") throw err(409, CODES.RUN_STATE_CONFLICT, "Only a failed run can be resumed");
  const attempt = run.attempt + 1;
  const upd = await ProvisioningRun.updateOne(
    { runId: run.runId, tenantId: run.tenantId, status: "failed", attempt: run.attempt },
    {
      $set: {
        status: "pending",
        attempt,
        failureCode: null,
        failedStep: null,
        "steps.$[open].status": "pending",
        "steps.$[open].failureCode": null,
        "steps.$[open].completedAt": null,
      },
      $push: { history: { $each: [historyEntry(actor, "resumed", "failed", "pending", attempt)], $slice: -HISTORY_CAP } },
    },
    { arrayFilters: [{ "open.status": { $ne: "succeeded" } }], runValidators: true }
  );
  if (upd.modifiedCount !== 1) throw err(409, CODES.RUN_STATE_CONFLICT, "Concurrent change: run not resumed");
  return ProvisioningRun.findOne({ runId: run.runId, tenantId: run.tenantId }).lean();
}

/** Public view: ids, status and counts only. */
function toRunView(run) {
  return {
    runId: run.runId,
    tenantId: run.tenantId,
    templateKey: run.templateKey,
    templateVersion: run.templateVersion,
    templateContentHash: run.templateContentHash,
    status: run.status,
    attempt: run.attempt,
    failureCode: run.failureCode,
    failedStep: run.failedStep,
    steps: run.steps.map((s) => ({ order: s.order, key: s.key, component: s.component, service: s.service, version: s.version, required: s.required, status: s.status, insertedCount: s.insertedCount, skippedCount: s.skippedCount, failureCode: s.failureCode, attempts: s.attempts, completedAt: s.completedAt })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

module.exports = { CODES, assertInternalTenantId, createOrGetRun, getRun, listRuns, recordStepResult, resumeRun, toRunView, planSteps, loadPublishedTemplate };
