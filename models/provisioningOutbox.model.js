/**
 * ProvisioningOutbox (Phase B / P3 prerequisite): the transactional outbox for provisioning step requests.
 *
 * A row is inserted in the SAME MongoDB transaction as the run / step transition it announces
 * (services/provisioningOrchestrator.js requestNextStep): a committed "step requested" transition always has its
 * row, and a row never exists for an uncommitted transition. services/provisioningOutboxPublisher.js publishes
 * pending rows through rabbitmq-middleware publishConfirmed (broker ack) and marks them published only after the
 * ack; a crash between ack and mark re-publishes the SAME eventId, which consumers deduplicate.
 *
 *  - eventId: deterministic (constants/provisioningStepKeys.js eventIdFor(eventType, stepKey, attempt)); unique.
 *  - one logical event per (eventType, stepKey, attempt): unique index - a retried command cannot add a second.
 *  - tenantId = the run's target (internal tenant id), immutable (A15 plugin); also the event envelope tenant.
 *  - payload: a fixed, strict shape (ids, versions, digests) - no secrets, tokens, emails or tenant locators.
 *  - status: pending -> published | dead (bounded retries exhausted; observable, never silently dropped).
 */
const mongoose = require("mongoose");
const { tenantOwnershipPlugin } = require("./plugins/tenantOwnership.plugin");

const EVENT_TYPES = ["tenant.provisioning.step.requested.v1"];
const STATUSES = ["pending", "published", "dead"];
const ERROR_CODES = ["BROKER_NACK", "CONFIRM_TIMEOUT", "CHANNEL_UNAVAILABLE", "PUBLISH_ERROR", "MIDDLEWARE_CONFIRM_UNAVAILABLE"];
const ID = /^[0-9a-f]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STEP_KEY = /^psk2:[0-9a-f-]{36}:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/;

const payloadSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, match: UUID },
    tenantId: { type: String, required: true, match: ID },
    stepKey: { type: String, required: true, match: STEP_KEY },
    stepKeyVersion: { type: Number, required: true, enum: [2] },
    service: { type: String, required: true, maxlength: 64 },
    component: { type: String, required: true, maxlength: 100 },
    action: { type: String, required: true, maxlength: 40 },
    manifestVersion: { type: Number, required: true, min: 1 },
    manifestSha256: { type: String, required: true, match: SHA256 },
    attempt: { type: Number, required: true, min: 1 },
    templateKey: { type: String, required: true, maxlength: 64 },
    templateVersion: { type: Number, required: true, min: 1 },
  },
  { _id: false, strict: "throw" }
);

const outboxSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, match: /^prov_[0-9a-f]{40}$/, immutable: true },
    eventType: { type: String, required: true, enum: EVENT_TYPES, immutable: true },
    runId: { type: String, required: true, match: UUID, immutable: true },
    tenantId: { type: String, required: true, match: ID },
    stepKey: { type: String, required: true, match: STEP_KEY, immutable: true },
    attempt: { type: Number, required: true, min: 1, immutable: true },
    payload: { type: payloadSchema, required: true, immutable: true },
    status: { type: String, required: true, enum: STATUSES, default: "pending" },
    publishAttempts: { type: Number, required: true, min: 0, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    leaseUntil: { type: Date, default: null },
    lastErrorCode: { type: String, enum: [...ERROR_CODES, null], default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: "throw", collection: "provisioningoutbox" }
);

outboxSchema.index({ eventId: 1 }, { unique: true, name: "uniq_outbox_event_id" });
outboxSchema.index({ eventType: 1, stepKey: 1, attempt: 1 }, { unique: true, name: "uniq_outbox_logical_event" });
outboxSchema.index({ status: 1, nextAttemptAt: 1 }, { name: "outbox_due" });

outboxSchema.plugin(tenantOwnershipPlugin, { modelName: "ProvisioningOutbox" });
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  outboxSchema.pre(op, (next) => next(new Error("ProvisioningOutbox rows are never deleted")));
}

const ProvisioningOutbox = mongoose.model("ProvisioningOutbox", outboxSchema);
Object.assign(ProvisioningOutbox, { EVENT_TYPES, STATUSES, ERROR_CODES });

module.exports = ProvisioningOutbox;
