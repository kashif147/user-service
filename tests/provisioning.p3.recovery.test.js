/**
 * Phase B / P3 - dead-outbox recovery (owner decision 2026-11-01): a dead request event for a RUNNING step of the
 * same run / step key / attempt -> step + run failed with the fixed code OUTBOX_DELIVERY_EXHAUSTED, transactionally;
 * then resume starts a NEW attempt with its own event id. Real single-node replica set (skipped without mongod).
 * Dead rows are produced in the test database only (never on live DEV).
 */
const mockAudits = [];
jest.mock("../rabbitMQ", () => ({ publishDomainEvent: (...a) => (mockAudits.push(a), Promise.resolve(true)) }));

const crypto = require("crypto");
const mongoose = require("mongoose");
const { mongodBin, startReplSet } = require("./helpers/replSetMongod");
const PlatformTemplate = require("../models/platformTemplate.model");
const ProvisioningRun = require("../models/provisioningRun.model");
const ProvisioningOutbox = require("../models/provisioningOutbox.model");
const runs = require("../services/provisioningRunService");
const orchestrator = require("../services/provisioningOrchestrator");
const outboxPublisher = require("../services/provisioningOutboxPublisher");
const { DEFINITIONS, templateContentHash } = require("../constants/platformTemplates");

jest.setTimeout(90000);
const DEF = DEFINITIONS[0];
const PID = "6a0000000000000000000a03";
const { COMPLETED, FAILED } = orchestrator.EVENT_TYPES;

const describeDb = mongodBin ? describe : describe.skip;
describeDb("dead-outbox recovery against a real replica set", () => {
  let rs;
  let tenantId;
  beforeAll(async () => {
    rs = await startReplSet("prov-p3-rec", "prov-p3-rec-test");
    await PlatformTemplate.init();
    await ProvisioningRun.init();
    await ProvisioningOutbox.init();
  });
  afterAll(async () => { if (rs) await rs.stop(); });
  beforeEach(async () => {
    const db = mongoose.connection.db;
    for (const c of ["provisioningruns", "provisioningoutbox", "platformtemplates", "tenants"]) await db.collection(c).deleteMany({});
    tenantId = String(new mongoose.Types.ObjectId());
    await db.collection("tenants").insertOne({ _id: new mongoose.Types.ObjectId(tenantId), name: "P3-REC", code: "P3REC", status: "ACTIVE", isActive: true });
    await PlatformTemplate.create({ key: DEF.key, version: DEF.version, description: DEF.description, components: DEF.components.map((c) => ({ ...c })), contentHash: templateContentHash(DEF), status: "published", publishedAt: new Date(), publishedBy: "p3-test" });
    mockAudits.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  const docHash = async (runId) => crypto.createHash("md5").update(JSON.stringify(await mongoose.connection.db.collection("provisioningruns").findOne({ runId }))).digest("hex");
  // a requested step whose outbox row exhausted its publish attempts (in this test DB)
  async function deadStep() {
    const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
    const req = await orchestrator.requestNextStep({ runId: run.runId });
    await ProvisioningOutbox.updateOne({ eventId: req.eventId, tenantId }, { $set: { publishAttempts: outboxPublisher.MAX_ATTEMPTS - 1, nextAttemptAt: new Date(0) } });
    await outboxPublisher.publishDueOnce({ publishFn: async () => ({ success: false, error: "broker nack" }) });
    const row = await ProvisioningOutbox.findOne({ eventId: req.eventId }).lean();
    expect(row.status).toBe("dead");
    return { run, row, stepKey: req.stepKey };
  }
  const recover = (o) => orchestrator.failDeliveryExhaustedStep({ tenantId, principalId: PID, attempt: 1, ...o });

  test("dead matching row -> step and run failed with the FIXED code, history appended once, audit emitted", async () => {
    const { run, row, stepKey } = await deadStep();
    mockAudits.length = 0;
    const out = await recover({ runId: run.runId, stepKey });
    expect(out.changed).toBe(true);
    const stored = await ProvisioningRun.findOne({ runId: run.runId }).lean();
    const s = stored.steps.find((x) => x.key === stepKey);
    expect([stored.status, stored.failureCode, stored.failedStep, s.status, s.failureCode]).toEqual(["failed", "OUTBOX_DELIVERY_EXHAUSTED", stepKey, "failed", "OUTBOX_DELIVERY_EXHAUSTED"]);
    expect(stored.history.filter((h) => h.action === "delivery-exhausted")).toHaveLength(1);
    expect(stored.history.at(-1)).toMatchObject({ action: "delivery-exhausted", actor: { scope: "platform", principalId: PID }, fromStatus: "running", toStatus: "failed", attempt: 1 });
    expect(await ProvisioningOutbox.findOne({ eventId: row.eventId }).lean()).toMatchObject({ status: "dead" }); // evidence untouched
    expect(mockAudits.map((a) => [a[0], a[1].action, a[1].failureCode, a[2].auditContext.targetTenantId])).toEqual([["platform.provisioning.step.changed.v1", "PROVISIONING_STEP_FAILED", "OUTBOX_DELIVERY_EXHAUSTED", tenantId]]);
  });

  test("repeated recovery is idempotent: no change, no second history entry", async () => {
    const { run, stepKey } = await deadStep();
    await recover({ runId: run.runId, stepKey });
    const after = await docHash(run.runId);
    expect((await recover({ runId: run.runId, stepKey })).changed).toBe(false);
    expect(await docHash(run.runId)).toBe(after);
  });

  test("then resume starts a NEW attempt whose request has its own event id (the dead event is never resurrected)", async () => {
    const { run, row, stepKey } = await deadStep();
    await recover({ runId: run.runId, stepKey });
    await runs.resumeRun({ runId: run.runId, principalId: PID });
    const again = await orchestrator.requestNextStep({ runId: run.runId });
    expect(again).toMatchObject({ requested: true, stepKey });
    expect(again.eventId).not.toBe(row.eventId);
    expect(await ProvisioningOutbox.countDocuments({ runId: run.runId })).toBe(2);
  });

  test("a non-dead row (pending or published) cannot trigger recovery", async () => {
    const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
    const req = await orchestrator.requestNextStep({ runId: run.runId });
    const before = await docHash(run.runId);
    await expect(recover({ runId: run.runId, stepKey: req.stepKey })).rejects.toMatchObject({ code: "OUTBOX_NOT_DEAD" });
    await outboxPublisher.publishDueOnce({ publishFn: async (t, d, o) => ({ success: true, eventId: o.eventId }) });
    await expect(recover({ runId: run.runId, stepKey: req.stepKey })).rejects.toMatchObject({ code: "OUTBOX_NOT_DEAD" });
    expect(await docHash(run.runId)).toBe(before);
  });

  test("wrong tenant / wrong run / wrong or foreign step key / stale attempt -> refused, nothing changed", async () => {
    const { run, stepKey } = await deadStep();
    const before = await docHash(run.runId);
    await expect(recover({ runId: run.runId, stepKey, tenantId: String(new mongoose.Types.ObjectId()) })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(recover({ runId: run.runId, stepKey, tenantId: "MULTIAUTH" })).rejects.toMatchObject({ code: "INTERNAL_TENANT_ID_REQUIRED" });
    const otherRun = "33333333-3333-4333-8444-555555555555";
    await expect(recover({ runId: otherRun, stepKey: stepKey.replace(run.runId, otherRun) })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(recover({ runId: run.runId, stepKey: stepKey.replace(run.runId, otherRun) })).rejects.toMatchObject({ code: "INVALID_STEP_KEY" });
    await expect(recover({ runId: run.runId, stepKey: run.steps[1].key })).rejects.toMatchObject({ code: "STEP_NOT_RUNNING" });
    await expect(recover({ runId: run.runId, stepKey: `${tenantId}:standard-tenant@1:events-service:events-service:grid-system-defaults` })).rejects.toMatchObject({ code: "INVALID_STEP_KEY" });
    await expect(recover({ runId: run.runId, stepKey, attempt: 2 })).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    expect(await docHash(run.runId)).toBe(before);
  });

  test("a completed step cannot be changed by recovery", async () => {
    const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
    await orchestrator.requestNextStep({ runId: run.runId });
    const row = await ProvisioningOutbox.findOne({ runId: run.runId }).lean();
    await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: { eventId: "prov_r", tenantId, data: { runId: run.runId, tenantId, stepKey: row.stepKey, service: row.payload.service, component: row.payload.component, attempt: 1, manifestSha256: row.payload.manifestSha256, insertedCount: 1, skippedCount: 0 } } });
    await ProvisioningOutbox.updateOne({ eventId: row.eventId, tenantId }, { $set: { status: "dead" } }); // even if the row went dead
    const before = await docHash(run.runId);
    await expect(recover({ runId: run.runId, stepKey: row.stepKey })).rejects.toMatchObject({ code: "STEP_NOT_RUNNING" });
    expect(await docHash(run.runId)).toBe(before);
  });

  test("a service can never report OUTBOX_DELIVERY_EXHAUSTED itself", async () => {
    const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
    await orchestrator.requestNextStep({ runId: run.runId });
    const row = await ProvisioningOutbox.findOne({ runId: run.runId }).lean();
    const r = await orchestrator.handleStepResultEvent({ eventType: FAILED, envelope: { eventId: "prov_f", tenantId, data: { runId: run.runId, tenantId, stepKey: row.stepKey, service: row.payload.service, component: row.payload.component, attempt: 1, manifestSha256: row.payload.manifestSha256, failureCode: "OUTBOX_DELIVERY_EXHAUSTED" } } });
    expect(r).toMatchObject({ outcome: "refused", code: "MALFORMED_EVENT" });
  });

  test("recovery writes nothing outside the control plane (no application / default data)", async () => {
    const { run, stepKey } = await deadStep();
    await recover({ runId: run.runId, stepKey });
    const nonEmpty = [];
    for (const c of await mongoose.connection.db.listCollections().toArray()) if (await mongoose.connection.db.collection(c.name).countDocuments()) nonEmpty.push(c.name);
    expect(nonEmpty.sort()).toEqual(["platformtemplates", "provisioningoutbox", "provisioningruns", "tenants"]);
  });
});
