/**
 * ProvisioningRun (Phase B / P1): the persisted, auditable record of provisioning ONE tenant from ONE published
 * PlatformTemplate version. P1 is the control plane only - runs are recorded and their steps planned; nothing
 * here dispatches work to another service (that is the P3 transactional outbox, consumers are P4).
 *
 *  - tenantId = the TARGET tenant's internal ProjectShell id (24 lowercase hex), immutable (A15 plugin). Never
 *    an organisation code, Entra tid, email domain, the caller's tenant or a default-tenant variable.
 *  - One run per (tenantId, templateKey, templateVersion) - unique index: re-requesting returns the same run
 *    (idempotent), it never creates a second one or resets a completed one.
 *  - steps[] are planned from the template's components, in order; step key
 *    `<tenantId>:<templateKey>@<version>:<service>:<component>` is the per-step idempotency key carried by
 *    the P3 dispatch. A recorded terminal step result is never overwritten (compare-and-set in
 *    services/provisioningRunService.js); a required step failure fails the run - later steps are not started.
 *  - resume: failed -> pending, attempt + 1; succeeded steps stay succeeded and are skipped on replay.
 *  - actor = the platform principal id only. No tokens, secrets, emails, names, credentials or message bodies
 *    are stored; unknown fields are rejected (strict "throw").
 */
const mongoose = require("mongoose");
const { tenantOwnershipPlugin } = require("./plugins/tenantOwnership.plugin");
const { TEMPLATE_KEY } = require("../constants/platformTemplates");

const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RUN_STATUSES = ["pending", "running", "succeeded", "failed"];
const STEP_STATUSES = ["pending", "running", "succeeded", "failed"];
const OPEN_STATUSES = ["pending", "running"];
// Failure codes are fixed values (never free text from another service, never an error message).
const FAILURE_CODES = [
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
  "MANIFEST_VERSION_UNSUPPORTED",
  "MANIFEST_DIGEST_MISMATCH",
  "TENANT_ID_REJECTED",
  "ANOMALY_REFUSED",
  "STEP_ERROR",
];
const HISTORY_ACTIONS = ["created", "step-recorded", "failed", "succeeded", "resumed"];

const stepSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true, min: 1 },
    key: { type: String, required: true, maxlength: 300 },
    component: { type: String, required: true, maxlength: 100 },
    service: { type: String, required: true, maxlength: 64 },
    version: { type: Number, required: true, min: 1 },
    manifestSha256: { type: String, required: true, match: SHA256 },
    required: { type: Boolean, required: true },
    status: { type: String, required: true, enum: STEP_STATUSES, default: "pending" },
    insertedCount: { type: Number, min: 0, default: null },
    skippedCount: { type: Number, min: 0, default: null },
    failureCode: { type: String, enum: [...FAILURE_CODES, null], default: null },
    attempts: { type: Number, min: 0, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: false, strict: "throw" }
);

const actorSchema = new mongoose.Schema(
  {
    scope: { type: String, required: true, enum: ["platform", "system"] },
    // platform: the PlatformPrincipal id; system: a reserved system actor id (P3 orchestrator)
    principalId: { type: String, match: OBJECT_ID, default: null },
    actorId: { type: String, enum: ["platform:provisioning", null], default: null },
  },
  { _id: false, strict: "throw" }
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    action: { type: String, required: true, enum: HISTORY_ACTIONS },
    actor: { type: actorSchema, required: true },
    fromStatus: { type: String, enum: [...RUN_STATUSES, null], default: null },
    toStatus: { type: String, enum: RUN_STATUSES, required: true },
    step: { type: String, maxlength: 300, default: null },
    attempt: { type: Number, min: 1, required: true },
  },
  { _id: false, strict: "throw" }
);

const provisioningRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, match: UUID, immutable: true },
    tenantId: { type: String, required: true, match: INTERNAL_TENANT_ID },
    templateKey: { type: String, required: true, match: TEMPLATE_KEY, immutable: true },
    templateVersion: { type: Number, required: true, min: 1, immutable: true },
    templateContentHash: { type: String, required: true, match: SHA256, immutable: true },
    status: { type: String, required: true, enum: RUN_STATUSES, default: "pending" },
    attempt: { type: Number, required: true, min: 1, default: 1 },
    failureCode: { type: String, enum: [...FAILURE_CODES, null], default: null },
    failedStep: { type: String, maxlength: 300, default: null },
    steps: { type: [stepSchema], required: true },
    createdBy: { type: actorSchema, required: true, immutable: true },
    history: { type: [historySchema], default: [] },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: "throw", collection: "provisioningruns" }
);

provisioningRunSchema.index({ runId: 1 }, { unique: true, name: "uniq_provisioning_run_id" });
provisioningRunSchema.index({ tenantId: 1, templateKey: 1, templateVersion: 1 }, { unique: true, name: "uniq_tenant_template_version_run" });
provisioningRunSchema.index({ status: 1, updatedAt: 1 });

provisioningRunSchema.plugin(tenantOwnershipPlugin, { modelName: "ProvisioningRun" });

for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  provisioningRunSchema.pre(op, (next) => next(new Error("ProvisioningRun records are never deleted")));
}

const ProvisioningRun = mongoose.model("ProvisioningRun", provisioningRunSchema);
Object.assign(ProvisioningRun, { RUN_STATUSES, STEP_STATUSES, OPEN_STATUSES, FAILURE_CODES, INTERNAL_TENANT_ID });

module.exports = ProvisioningRun;
