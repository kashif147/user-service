/**
 * Phase B / P3 prerequisites (no distributed execution): canonical step keys, legacy P2 compatibility,
 * transactional outbox (atomicity, no duplicates), confirmed publisher (retry, dead, lease, crash-safety) and the
 * orchestrator's result-event validation (tenant triple, digest, attempt, order, duplicates). REAL single-node
 * replica-set mongod (MONGOD_BIN or `mongod` on PATH; skipped otherwise). The broker is a stub publishFn.
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
const keys = require("../constants/provisioningStepKeys");
const { DEFINITIONS, templateContentHash } = require("../constants/platformTemplates");
const { auditProvisioningStep } = require("../services/platformAuditService");

jest.setTimeout(90000);
const DEF = DEFINITIONS[0];
const PID = "6a0000000000000000000a03";
const RUN = "11111111-2222-4333-8444-555555555555";
const { COMPLETED, FAILED, REQUESTED } = orchestrator.EVENT_TYPES;

// ── pure contract (no DB) ────────────────────────────────────────────────────────────────────────────────────────
describe("canonical step key v2", () => {
  test("deterministic, service appears once, derived only from runId + component + action", () => {
    const k = keys.buildStepKey(RUN, "account-service:grid-system-defaults", "ensure-defaults");
    expect(k).toBe(`psk2:${RUN}:account-service:grid-system-defaults:ensure-defaults`);
    expect(keys.buildStepKey(RUN, "account-service:grid-system-defaults", "ensure-defaults")).toBe(k);
    expect(k.split(":").filter((x) => x === "account-service")).toHaveLength(1);
    expect(keys.parseStepKey(k)).toEqual({ version: 2, runId: RUN, service: "account-service", component: "grid-system-defaults", action: "ensure-defaults" });
    expect(k.length).toBeLessThanOrEqual(128);
  });
  test("refuses non-uuid run ids, duplicated / malformed namespaces, labels with spaces or case", () => {
    expect(() => keys.buildStepKey("6acd6119b28a863c61361ae0", "account-service:grid-system-defaults", "ensure-defaults")).toThrow(/uuid/);
    expect(() => keys.buildStepKey(RUN, "account-service:account-service:grid-system-defaults", "ensure-defaults")).toThrow(/componentKey/);
    expect(() => keys.buildStepKey(RUN, "Account Service:grid", "ensure-defaults")).toThrow(/componentKey/);
    expect(() => keys.buildStepKey(RUN, "account-service:grid-system-defaults", "Ensure Defaults")).toThrow(/action/);
  });
  test("the kept P2 run's legacy key shape parses as version 1 (never as v2); junk is null", () => {
    expect(keys.parseStepKey("6acd6119b28a863c61361ae0:standard-tenant@1:account-service:account-service:grid-system-defaults")).toEqual({ version: 1 });
    expect(keys.parseStepKey("psk2:not-a-uuid:a:b:c")).toBeNull();
    expect(keys.parseStepKey("anything")).toBeNull();
  });
  test("event ids: deterministic per (type, step, attempt), different for another attempt or type, middleware-safe", () => {
    const k = keys.buildStepKey(RUN, "events-service:grid-system-defaults", "ensure-defaults");
    const a = keys.eventIdFor(REQUESTED, k, 1);
    expect(keys.eventIdFor(REQUESTED, k, 1)).toBe(a);
    expect(keys.eventIdFor(REQUESTED, k, 2)).not.toBe(a);
    expect(keys.eventIdFor(COMPLETED, k, 1)).not.toBe(a);
    expect(a).toMatch(/^prov_[0-9a-f]{40}$/);
    expect(a).toMatch(/^[A-Za-z0-9._:-]{8,128}$/); // rabbitmq-middleware publishConfirmed eventId rule
  });
  test("step audit needs a verified target tenant (never emitted tenantless)", async () => {
    mockAudits.length = 0;
    expect(await auditProvisioningStep({ action: "PROVISIONING_STEP_REQUESTED", result: "success", tenantId: "MULTIAUTH", runId: RUN, stepKey: "k" })).toBe(false);
    expect(mockAudits).toHaveLength(0);
  });
});

const describeDb = mongodBin ? describe : describe.skip;
describeDb("outbox, publisher and result events against a real replica set", () => {
  let rs;
  let tenantId;
  beforeAll(async () => {
    rs = await startReplSet("prov-p3", "prov-p3-test");
    await PlatformTemplate.init();
    await ProvisioningRun.init();
    await ProvisioningOutbox.init();
  });
  afterAll(async () => { if (rs) await rs.stop(); });
  beforeEach(async () => {
    const db = mongoose.connection.db;
    for (const c of ["provisioningruns", "provisioningoutbox", "platformtemplates", "tenants"]) await db.collection(c).deleteMany({});
    tenantId = String(new mongoose.Types.ObjectId());
    await db.collection("tenants").insertOne({ _id: new mongoose.Types.ObjectId(tenantId), name: "P3-TEST", code: "P3TEST", status: "ACTIVE", isActive: true });
    await PlatformTemplate.create({ key: DEF.key, version: DEF.version, description: DEF.description, components: DEF.components.map((c) => ({ ...c })), contentHash: templateContentHash(DEF), status: "published", publishedAt: new Date(), publishedBy: "p3-test" });
    mockAudits.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  const newRun = async () => (await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID })).run;
  const docHash = async (runId) => crypto.createHash("md5").update(JSON.stringify(await mongoose.connection.db.collection("provisioningruns").findOne({ runId }))).digest("hex");
  const outboxCount = () => ProvisioningOutbox.countDocuments();
  const resultEnv = (row, over = {}, dataOver = {}) => ({
    eventId: keys.eventIdFor(COMPLETED, row.stepKey, row.attempt),
    tenantId: row.tenantId,
    data: { runId: row.payload.runId, tenantId: row.tenantId, stepKey: row.stepKey, service: row.payload.service, component: row.payload.component, attempt: row.attempt, manifestSha256: row.payload.manifestSha256, insertedCount: 4, skippedCount: 0, ...dataOver },
    ...over,
  });

  describe("transactional outbox", () => {
    test("a step request writes the run transition AND exactly one outbox row with the canonical payload", async () => {
      const run = await newRun();
      expect(run.stepKeyVersion).toBe(2);
      const r = await orchestrator.requestNextStep({ runId: run.runId });
      expect(r).toMatchObject({ requested: true, stepKey: run.steps[0].key, eventId: keys.eventIdFor(REQUESTED, run.steps[0].key, 1) });
      const stored = await ProvisioningRun.findOne({ runId: run.runId }).lean();
      expect([stored.status, stored.steps[0].status, stored.steps[0].attempts, stored.history.map((h) => h.action)]).toEqual(["running", "running", 1, ["created", "step-requested"]]);
      const rows = await ProvisioningOutbox.find({}).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ eventType: REQUESTED, runId: run.runId, tenantId, stepKey: run.steps[0].key, attempt: 1, status: "pending", publishAttempts: 0 });
      expect(rows[0].payload).toEqual({ runId: run.runId, tenantId, stepKey: run.steps[0].key, stepKeyVersion: 2, service: run.steps[0].service, component: run.steps[0].component, action: "ensure-defaults", manifestVersion: 1, manifestSha256: run.steps[0].manifestSha256, attempt: 1, templateKey: "standard-tenant", templateVersion: 1 });
      expect(JSON.stringify(rows[0])).not.toMatch(/eyJ|secret|password|@|organisation|directory/i);
      expect(mockAudits.map((a) => [a[0], a[1].action, a[2].auditContext])).toEqual([["platform.provisioning.step.changed.v1", "PROVISIONING_STEP_REQUESTED", { actorScope: "system", actorTenantId: null, targetTenantId: tenantId }]]);
    });

    test("atomic: an outbox failure rolls back the run transition (no transition without its event)", async () => {
      const run = await newRun();
      const before = await docHash(run.runId);
      jest.spyOn(ProvisioningOutbox, "create").mockImplementationOnce(async () => { throw new Error("simulated outbox write failure"); });
      await expect(orchestrator.requestNextStep({ runId: run.runId })).rejects.toThrow(/simulated/);
      expect(await docHash(run.runId)).toBe(before);
      expect(await outboxCount()).toBe(0);
    });

    test("atomic: an abort after the outbox insert leaves neither the row nor the transition (no event for an uncommitted transition)", async () => {
      const run = await newRun();
      const before = await docHash(run.runId);
      const real = ProvisioningOutbox.create.bind(ProvisioningOutbox);
      jest.spyOn(ProvisioningOutbox, "create").mockImplementationOnce(async (...a) => { await real(...a); throw new Error("simulated crash after insert"); });
      await expect(orchestrator.requestNextStep({ runId: run.runId })).rejects.toThrow(/simulated crash/);
      expect(await docHash(run.runId)).toBe(before);
      expect(await outboxCount()).toBe(0);
    });

    test("repeated / restarted / concurrent requests -> one logical event (no duplicate)", async () => {
      const run = await newRun();
      const first = await orchestrator.requestNextStep({ runId: run.runId });
      const again = await orchestrator.requestNextStep({ runId: run.runId });
      expect(again).toMatchObject({ requested: false, existing: true, eventId: first.eventId });
      // restart: the orchestrator holds no in-process state - drop and re-open the connection, ask again
      await mongoose.disconnect();
      await mongoose.connect(rs.uri, { serverSelectionTimeoutMS: 5000 });
      expect(await orchestrator.requestNextStep({ runId: run.runId })).toMatchObject({ requested: false, eventId: first.eventId });
      const second = await newRun(); // same tenant+template => same run (idempotent create)
      expect(second.runId).toBe(run.runId);
      expect(await outboxCount()).toBe(1);
    });

    test("concurrent first requests on a fresh run: exactly one transition and one row", async () => {
      const run = await newRun();
      const res = await Promise.allSettled(Array.from({ length: 6 }, () => orchestrator.requestNextStep({ runId: run.runId })));
      const ok = res.filter((x) => x.status === "fulfilled").map((x) => x.value);
      expect(ok.filter((v) => v.requested)).toHaveLength(1);
      expect(new Set(ok.map((v) => v.eventId)).size).toBe(1);
      res.filter((x) => x.status === "rejected").forEach((x) => expect(x.reason.code || x.reason.codeName || x.reason.message).toMatch(/RUN_STATE_CONFLICT|WriteConflict|E11000/));
      expect(await outboxCount()).toBe(1);
      expect((await ProvisioningRun.findOne({ runId: run.runId }).lean()).steps[0].attempts).toBe(1);
    });

    test("legacy v1 run (the kept P2 shape): never dispatched, never recorded, never rewritten", async () => {
      const legacyRunId = "22222222-2222-4333-8444-555555555555";
      const legacyKey = `${tenantId}:standard-tenant@1:account-service:account-service:grid-system-defaults`;
      await mongoose.connection.db.collection("provisioningruns").insertOne({
        runId: legacyRunId, tenantId, templateKey: "standard-tenant", templateVersion: 1, templateContentHash: templateContentHash(DEF), status: "pending", attempt: 1, failureCode: null, failedStep: null,
        steps: [{ order: 1, key: legacyKey, component: "account-service:grid-system-defaults", service: "account-service", version: 1, manifestSha256: DEF.components[0].manifestSha256, required: true, status: "pending", insertedCount: null, skippedCount: null, failureCode: null, attempts: 0, startedAt: null, completedAt: null }],
        createdBy: { scope: "platform", principalId: PID, actorId: null }, history: [], completedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
      });
      const before = await docHash(legacyRunId);
      await expect(orchestrator.requestNextStep({ runId: legacyRunId })).rejects.toMatchObject({ code: "LEGACY_STEP_KEY_VERSION" });
      await expect(runs.recordStepResult({ runId: legacyRunId, tenantId, stepKey: legacyKey, result: { status: "succeeded", insertedCount: 1, skippedCount: 0 }, actor: orchestrator.ORCHESTRATOR })).rejects.toMatchObject({ code: "LEGACY_STEP_KEY_VERSION" });
      const env = { eventId: "prov_x", tenantId, data: { runId: legacyRunId, tenantId, stepKey: legacyKey, service: "account-service", attempt: 1, manifestSha256: DEF.components[0].manifestSha256, insertedCount: 1, skippedCount: 0 } };
      expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: env })).toMatchObject({ outcome: "refused", code: "INVALID_STEP_KEY" });
      expect(runs.toRunView(await ProvisioningRun.findOne({ runId: legacyRunId }).lean()).stepKeyVersion).toBe(1);
      expect(await docHash(legacyRunId)).toBe(before);
      expect(await outboxCount()).toBe(0);
    });
  });

  describe("confirmed publisher", () => {
    const stub = (results) => { const calls = []; const fn = async (type, data, opts) => { calls.push({ type, data, opts }); return results.length ? results.shift() : { success: true, eventId: opts.eventId }; }; fn.calls = calls; return fn; };

    test("broker ack -> published (CAS); the published row is never sent again", async () => {
      const run = await newRun();
      const { eventId } = await orchestrator.requestNextStep({ runId: run.runId });
      const fn = stub([]);
      expect(await outboxPublisher.publishDueOnce({ publishFn: fn })).toMatchObject({ published: 1 });
      expect(fn.calls[0]).toMatchObject({ type: REQUESTED, opts: { eventId, tenantId } });
      expect(await ProvisioningOutbox.findOne({ eventId }).lean()).toMatchObject({ status: "published", lastErrorCode: null });
      expect(await outboxPublisher.publishDueOnce({ publishFn: fn })).toMatchObject({ published: 0 });
      expect(fn.calls).toHaveLength(1);
    });

    test("nack / timeout -> stays pending with backoff and a fixed error code; bounded -> dead (kept, observable)", async () => {
      const run = await newRun();
      const { eventId } = await orchestrator.requestNextStep({ runId: run.runId });
      const now = new Date();
      await outboxPublisher.publishDueOnce({ now, publishFn: stub([{ success: false, error: "broker nack" }]) });
      let row = await ProvisioningOutbox.findOne({ eventId }).lean();
      expect([row.status, row.publishAttempts, row.lastErrorCode, row.nextAttemptAt.getTime() - now.getTime()]).toEqual(["pending", 1, "BROKER_NACK", outboxPublisher.backoff(1)]);
      expect(await outboxPublisher.publishDueOnce({ now, publishFn: stub([]) })).toMatchObject({ published: 0 }); // not due yet
      await outboxPublisher.publishDueOnce({ now: new Date(now.getTime() + 60000), publishFn: stub([{ success: false, error: "confirm timeout" }]) });
      expect((await ProvisioningOutbox.findOne({ eventId }).lean()).lastErrorCode).toBe("CONFIRM_TIMEOUT");
      await ProvisioningOutbox.updateOne({ eventId, tenantId }, { $set: { publishAttempts: outboxPublisher.MAX_ATTEMPTS - 1, nextAttemptAt: now } });
      expect(await outboxPublisher.publishDueOnce({ now, publishFn: stub([{ success: false, error: "channel closed" }]) })).toMatchObject({ dead: 1 });
      row = await ProvisioningOutbox.findOne({ eventId }).lean();
      expect([row.status, row.lastErrorCode]).toEqual(["dead", "CHANNEL_UNAVAILABLE"]);
      expect(await outboxCount()).toBe(1); // never dropped
    });

    test("crash between broker ack and mark -> the SAME eventId is re-published (consumers deduplicate)", async () => {
      const run = await newRun();
      const { eventId } = await orchestrator.requestNextStep({ runId: run.runId });
      const fn = stub([]);
      const realUpdate = ProvisioningOutbox.updateOne.bind(ProvisioningOutbox);
      let n = 0;
      jest.spyOn(ProvisioningOutbox, "updateOne").mockImplementation((...a) => { n += 1; if (n === 2) throw new Error("simulated crash before mark"); return realUpdate(...a); });
      await expect(outboxPublisher.publishDueOnce({ publishFn: fn })).rejects.toThrow(/simulated crash/);
      jest.restoreAllMocks();
      await outboxPublisher.publishDueOnce({ now: new Date(Date.now() + 31000), publishFn: fn }); // lease expired
      expect(fn.calls.map((c) => c.opts.eventId)).toEqual([eventId, eventId]);
      expect((await ProvisioningOutbox.findOne({ eventId }).lean()).status).toBe("published");
    });

    test("two publishers at once: the lease lets only one send", async () => {
      const run = await newRun();
      await orchestrator.requestNextStep({ runId: run.runId });
      const fn = stub([]);
      await Promise.all([outboxPublisher.publishDueOnce({ publishFn: fn }), outboxPublisher.publishDueOnce({ publishFn: fn })]);
      expect(fn.calls).toHaveLength(1);
    });

    test("fails closed on the currently installed middleware (no publishConfirmed): nothing sent, row stays pending", async () => {
      const run = await newRun();
      const { eventId } = await orchestrator.requestNextStep({ runId: run.runId });
      expect(await outboxPublisher.publishDueOnce({})).toMatchObject({ blocked: "MIDDLEWARE_CONFIRM_UNAVAILABLE" });
      expect((await ProvisioningOutbox.findOne({ eventId }).lean()).status).toBe("pending");
    });

    test("not started without PROVISIONING_OUTBOX_PUBLISHER=on", () => {
      delete process.env.PROVISIONING_OUTBOX_PUBLISHER;
      expect(outboxPublisher.startOutboxPublisher()).toMatchObject({ started: false });
    });
  });

  describe("result events (owning service -> orchestrator)", () => {
    const requested = async () => {
      const run = await newRun();
      await orchestrator.requestNextStep({ runId: run.runId });
      return { run, row: await ProvisioningOutbox.findOne({ runId: run.runId }).lean() };
    };

    test("valid completion -> recorded; duplicate delivery -> DUPLICATE with zero writes", async () => {
      const { run, row } = await requested();
      expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row) })).toMatchObject({ outcome: "recorded", code: "RECORDED", stepStatus: "succeeded", runStatus: "running" });
      const after = await docHash(run.runId);
      expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row) })).toMatchObject({ outcome: "duplicate" });
      expect(await docHash(run.runId)).toBe(after);
      const s = (await ProvisioningRun.findOne({ runId: run.runId }).lean()).steps[0];
      expect([s.insertedCount, s.skippedCount]).toEqual([4, 0]);
    });

    test("tenant boundary: envelope != event tenant, or != run tenant -> refused, nothing recorded", async () => {
      const { run, row } = await requested();
      const before = await docHash(run.runId);
      const other = String(new mongoose.Types.ObjectId());
      for (const env of [resultEnv(row, { tenantId: other }), resultEnv(row, {}, { tenantId: other }), resultEnv(row, { tenantId: other }, { tenantId: other }), resultEnv(row, { tenantId: "DEVTENANTB" }, { tenantId: "DEVTENANTB" })]) {
        expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: env })).toMatchObject({ outcome: "refused", code: "TENANT_MISMATCH" });
      }
      expect(await docHash(run.runId)).toBe(before);
    });

    test("manifest digest mismatch -> the step FAILS (MANIFEST_DIGEST_MISMATCH), never success; the run stops", async () => {
      const { run, row } = await requested();
      const r = await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row, {}, { manifestSha256: "0".repeat(64) }) });
      expect(r).toMatchObject({ outcome: "recorded", code: "MANIFEST_DIGEST_MISMATCH", stepStatus: "failed", runStatus: "failed" });
      const stored = await ProvisioningRun.findOne({ runId: run.runId }).lean();
      expect([stored.failureCode, stored.failedStep, stored.steps[0].insertedCount]).toEqual(["MANIFEST_DIGEST_MISMATCH", row.stepKey, null]);
      // the same mismatched completion again = redelivery; a later "success" (even with the pinned digest) is refused
      expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row, {}, { manifestSha256: "0".repeat(64) }) })).toMatchObject({ outcome: "duplicate" });
      expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row) })).toMatchObject({ outcome: "refused", code: "RESULT_CONFLICT" });
      expect((await ProvisioningRun.findOne({ runId: run.runId }).lean()).steps[0]).toMatchObject({ status: "failed", failureCode: "MANIFEST_DIGEST_MISMATCH" });
    });

    test("stale attempt: a result for attempt 1 after the run was resumed (attempt 2) is refused", async () => {
      const { run, row } = await requested();
      await orchestrator.handleStepResultEvent({ eventType: FAILED, envelope: resultEnv(row, {}, { failureCode: "TIMEOUT", insertedCount: undefined, skippedCount: undefined }) });
      await runs.resumeRun({ runId: run.runId, principalId: PID });
      await orchestrator.requestNextStep({ runId: run.runId });
      const before = await docHash(run.runId);
      expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row) })).toMatchObject({ outcome: "refused", code: "STALE_ATTEMPT" });
      expect(await docHash(run.runId)).toBe(before);
      const row2 = await ProvisioningOutbox.findOne({ runId: run.runId, attempt: 2 }).lean();
      expect(row2.eventId).not.toBe(row.eventId);
      expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row2) })).toMatchObject({ outcome: "recorded" });
    });

    test("out-of-order: a completion for a step that was never requested is refused", async () => {
      const { run, row } = await requested();
      const s2 = run.steps[1];
      const env = resultEnv(row, {}, { stepKey: s2.key, service: s2.service, component: s2.component, manifestSha256: s2.manifestSha256 });
      expect(await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: env })).toMatchObject({ outcome: "refused", code: "STEP_NOT_REQUESTED" });
    });

    test("conflicting result for a finished step, unknown run, foreign / malformed key, wrong service, bad payload -> refused", async () => {
      const { run, row } = await requested();
      await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row) });
      const before = await docHash(run.runId);
      const h = (eventType, env) => orchestrator.handleStepResultEvent({ eventType, envelope: env });
      expect(await h(FAILED, resultEnv(row, {}, { failureCode: "TIMEOUT" }))).toMatchObject({ code: "RESULT_CONFLICT" });
      // a "completed" for the finished step is a redelivery ONLY if it is the same result
      expect(await h(COMPLETED, resultEnv(row, {}, { manifestSha256: "0".repeat(64) }))).toMatchObject({ code: "RESULT_CONFLICT" });
      expect(await h(COMPLETED, resultEnv(row, {}, { insertedCount: 3, skippedCount: 1 }))).toMatchObject({ code: "RESULT_CONFLICT" });
      expect(await h(COMPLETED, resultEnv(row))).toMatchObject({ outcome: "duplicate" });
      const otherRun = "33333333-3333-4333-8444-555555555555";
      expect(await h(COMPLETED, resultEnv(row, {}, { runId: otherRun, stepKey: row.stepKey.replace(run.runId, otherRun) }))).toMatchObject({ code: "UNKNOWN_RUN" });
      expect(await h(COMPLETED, resultEnv(row, {}, { stepKey: row.stepKey.replace(run.runId, otherRun) }))).toMatchObject({ code: "INVALID_STEP_KEY" });
      expect(await h(COMPLETED, resultEnv(row, {}, { service: "profile-service" }))).toMatchObject({ code: "STEP_MISMATCH" });
      expect(await h(COMPLETED, resultEnv(row, {}, { insertedCount: -1 }))).toMatchObject({ code: "MALFORMED_EVENT" });
      expect(await h(FAILED, resultEnv(row, {}, { failureCode: "free text from a service" }))).toMatchObject({ code: "MALFORMED_EVENT" });
      expect(await h("tenant.provisioning.step.requested.v1", resultEnv(row))).toMatchObject({ code: "MALFORMED_EVENT" });
      expect(await docHash(run.runId)).toBe(before);
    });

    test("the control plane still writes nothing outside its own collections (no defaults, users, roles, tenantless rows)", async () => {
      const { row } = await requested();
      await orchestrator.handleStepResultEvent({ eventType: COMPLETED, envelope: resultEnv(row) });
      const nonEmpty = [];
      for (const c of await mongoose.connection.db.listCollections().toArray()) if (await mongoose.connection.db.collection(c.name).countDocuments()) nonEmpty.push(c.name);
      expect(nonEmpty.sort()).toEqual(["platformtemplates", "provisioningoutbox", "provisioningruns", "tenants"]);
      expect(await ProvisioningOutbox.countDocuments({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] })).toBe(0);
      expect(mockAudits.every((a) => a[2].auditContext.actorScope === "system" && a[2].auditContext.targetTenantId === tenantId)).toBe(true);
    });
  });
});
