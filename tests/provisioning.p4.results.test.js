/**
 * Phase B / P4 - user-service result consumer (tenant.provisioning.step.completed/failed.v1) and the dispatch
 * trigger (requestNextStep behind the platform route). Both implemented, NOT active: the consumer binds only with
 * PROVISIONING_RESULT_CONSUMER=on, the dispatch route exists only with PROVISIONING_DISPATCH=on.
 * Real single-node replica set (skipped without mongod); the broker is never touched.
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
const results = require("../rabbitMQ/provisioningResults");
const { DEFINITIONS, templateContentHash } = require("../constants/platformTemplates");

jest.setTimeout(90000);
const DEF = DEFINITIONS[0];
const PID = "6a0000000000000000000a03";
const { COMPLETED, FAILED } = orchestrator.EVENT_TYPES;

describe("activation gates (default OFF)", () => {
  afterEach(() => { delete process.env.PROVISIONING_RESULT_CONSUMER; delete process.env.PROVISIONING_DISPATCH; });
  const fakeConsumer = () => { const calls = []; return { calls, createQueue: async (q) => calls.push(["createQueue", q]), bindQueue: async (q, ex, k) => calls.push(["bindQueue", q, ex, k]), registerHandler: (t) => calls.push(["registerHandler", t]), consume: async (q) => calls.push(["consume", q]) }; };

  test("result consumer: not bound unless PROVISIONING_RESULT_CONSUMER=on; when on, exactly one queue for completed/failed", async () => {
    for (const v of [undefined, "true", "1"]) {
      if (v === undefined) delete process.env.PROVISIONING_RESULT_CONSUMER; else process.env.PROVISIONING_RESULT_CONSUMER = v;
      const c = fakeConsumer();
      expect(await results.setupProvisioningResultConsumer(c)).toEqual({ bound: false });
      expect(c.calls).toEqual([]);
    }
    process.env.PROVISIONING_RESULT_CONSUMER = "on";
    const c = fakeConsumer();
    jest.spyOn(console, "log").mockImplementation(() => {});
    expect(await results.setupProvisioningResultConsumer(c)).toEqual({ bound: true, queue: "user.provisioning.results" });
    expect(c.calls).toEqual([["createQueue", "user.provisioning.results"], ["bindQueue", "user.provisioning.results", "provisioning.events", [COMPLETED, FAILED]], ["registerHandler", COMPLETED], ["registerHandler", FAILED], ["consume", "user.provisioning.results"]]);
    jest.restoreAllMocks();
  });

  test("dispatch route: absent by default; with PROVISIONING_DISPATCH=on present and platform-guarded (route-enforce)", () => {
    const routesOf = () => {
      let r;
      jest.isolateModules(() => { r = require("../routes/provisioning.routes"); });
      return r.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, guard: l.route.stack[0].name }));
    };
    expect(routesOf().some((r) => /dispatch/.test(r.path))).toBe(false);
    process.env.PROVISIONING_DISPATCH = "on";
    const d = routesOf().filter((r) => /dispatch/.test(r.path));
    expect(d).toEqual([{ path: "/platform/provisioning/tenants/:targetTenantId/runs/:runId/dispatch", guard: "platformAuthzGuard" }]);
  });

  test("dispatch controller: any body is refused before the orchestrator is called", async () => {
    const ctl = require("../controllers/provisioning.controller");
    const spy = jest.spyOn(orchestrator, "requestNextStep");
    let errOut;
    await ctl.dispatchNextStep({ body: { stepKey: "x" }, params: { targetTenantId: "6acd6119b28a863c61361ae0", runId: "x" }, platform: { pid: PID }, ctx: {}, headers: {} }, {}, (e) => { errOut = e; });
    expect(errOut).toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

const describeDb = mongodBin ? describe : describe.skip;
describeDb("result consumer + dispatch against a real replica set", () => {
  let rs;
  let tenantId;
  beforeAll(async () => {
    rs = await startReplSet("prov-p4", "prov-p4-test");
    await PlatformTemplate.init();
    await ProvisioningRun.init();
    await ProvisioningOutbox.init();
  });
  afterAll(async () => { if (rs) await rs.stop(); });
  beforeEach(async () => {
    const db = mongoose.connection.db;
    for (const c of ["provisioningruns", "provisioningoutbox", "platformtemplates", "tenants"]) await db.collection(c).deleteMany({});
    tenantId = String(new mongoose.Types.ObjectId());
    await db.collection("tenants").insertOne({ _id: new mongoose.Types.ObjectId(tenantId), name: "P4", code: "P4TEST", status: "ACTIVE", isActive: true });
    await PlatformTemplate.create({ key: DEF.key, version: DEF.version, description: DEF.description, components: DEF.components.map((c) => ({ ...c })), contentHash: templateContentHash(DEF), status: "published", publishedAt: new Date(), publishedBy: "p4-test" });
    mockAudits.length = 0;
    jest.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const hash = async (runId) => crypto.createHash("md5").update(JSON.stringify(await mongoose.connection.db.collection("provisioningruns").findOne({ runId }))).digest("hex");
  const dispatched = async () => {
    const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
    const out = await orchestrator.requestNextStep({ runId: run.runId, tenantId });
    return { run, out, row: await ProvisioningOutbox.findOne({ eventId: out.eventId }).lean() };
  };
  // a message as the owning service publishes it (middleware publishConfirmed envelope + header)
  const msg = (row, type, dOver = {}, eOver = {}, header) => {
    const data = { runId: row.payload.runId, tenantId: row.tenantId, stepKey: row.stepKey, service: row.payload.service, component: row.payload.component, attempt: row.attempt, manifestSha256: row.payload.manifestSha256, ...(type === COMPLETED ? { insertedCount: 4, skippedCount: 0 } : { failureCode: "TIMEOUT" }), ...dOver };
    const payload = { eventId: `prov_${"b".repeat(40)}`, eventType: type, tenantId: row.tenantId, data, ...eOver };
    return [payload, { headers: { "x-tenant-id": header !== undefined ? header : payload.tenantId } }];
  };
  const h = (args) => results.handleProvisioningResultMessage(...args);

  test("dispatch: target tenant must be the run's; one transaction writes step transition + one outbox row; nothing published", async () => {
    const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
    await expect(orchestrator.requestNextStep({ runId: run.runId, tenantId: String(new mongoose.Types.ObjectId()) })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(orchestrator.requestNextStep({ runId: run.runId, tenantId: "DEVTENANTB" })).rejects.toMatchObject({ code: "INTERNAL_TENANT_ID_REQUIRED" });
    expect(await ProvisioningOutbox.countDocuments()).toBe(0);
    const out = await orchestrator.requestNextStep({ runId: run.runId, tenantId });
    expect(out).toMatchObject({ requested: true, stepKey: run.steps[0].key });
    expect(await ProvisioningOutbox.countDocuments({ status: "pending" })).toBe(1);
    expect(mockAudits.map((a) => a[0])).toEqual(["platform.provisioning.step.changed.v1"]); // only the step audit; no provisioning event published
  });

  test("first dispatch always takes template order 1 (account), never a later component", async () => {
    const { out } = await dispatched();
    expect(out.stepKey).toMatch(/:account-service:grid-system-defaults:ensure-defaults$/);
  });

  test("successful completion recorded; identical duplicate harmless; conflicting duplicate -> RESULT_CONFLICT", async () => {
    const { run, row } = await dispatched();
    expect(await h(msg(row, COMPLETED))).toMatchObject({ outcome: "recorded", code: "RECORDED" });
    const after = await hash(run.runId);
    expect(await h(msg(row, COMPLETED))).toMatchObject({ outcome: "duplicate" });
    expect(await h(msg(row, COMPLETED, { insertedCount: 0, skippedCount: 4 }))).toMatchObject({ outcome: "refused", code: "RESULT_CONFLICT" });
    expect(await h(msg(row, FAILED))).toMatchObject({ outcome: "refused", code: "RESULT_CONFLICT" });
    expect(await hash(run.runId)).toBe(after);
  });

  test("fixed failure recorded -> run failed; free-text / reserved failure codes refused", async () => {
    const { run, row } = await dispatched();
    expect(await h(msg(row, FAILED, { failureCode: "free text" }))).toMatchObject({ code: "MALFORMED_EVENT" });
    expect(await h(msg(row, FAILED, { failureCode: "OUTBOX_DELIVERY_EXHAUSTED" }))).toMatchObject({ code: "MALFORMED_EVENT" });
    expect(await h(msg(row, FAILED))).toMatchObject({ outcome: "recorded", stepStatus: "failed", runStatus: "failed" });
    expect((await ProvisioningRun.findOne({ runId: run.runId }).lean()).failureCode).toBe("TIMEOUT");
  });

  test("hash mismatch -> step failed MANIFEST_DIGEST_MISMATCH (never success)", async () => {
    const { row } = await dispatched();
    expect(await h(msg(row, COMPLETED, { manifestSha256: "0".repeat(64) }))).toMatchObject({ outcome: "recorded", code: "MANIFEST_DIGEST_MISMATCH", stepStatus: "failed" });
  });

  test("wrong tenant (header / envelope / data), unknown run, legacy run, out-of-order, stale attempt -> refused, nothing recorded", async () => {
    const { run, row } = await dispatched();
    const before = await hash(run.runId);
    const other = String(new mongoose.Types.ObjectId());
    expect(await h(msg(row, COMPLETED, {}, {}, other))).toMatchObject({ code: "TENANT_MISMATCH" }); // header
    expect(await h(msg(row, COMPLETED, {}, {}, ""))).toMatchObject({ code: "TENANT_MISMATCH" });
    expect(await h(msg(row, COMPLETED, { tenantId: other }))).toMatchObject({ code: "TENANT_MISMATCH" }); // data
    expect(await h(msg(row, COMPLETED, {}, { tenantId: other }, other))).toMatchObject({ code: "TENANT_MISMATCH" }); // envelope+header vs data
    const ghost = "55555555-5555-4555-8555-555555555555";
    expect(await h(msg(row, COMPLETED, { runId: ghost, stepKey: row.stepKey.replace(run.runId, ghost) }))).toMatchObject({ code: "UNKNOWN_RUN" });
    const s2 = run.steps[1];
    expect(await h(msg(row, COMPLETED, { stepKey: s2.key, service: s2.service, component: s2.component, manifestSha256: s2.manifestSha256 }))).toMatchObject({ code: "STEP_NOT_REQUESTED" }); // out of order
    expect(await h(msg(row, COMPLETED, { attempt: 2 }))).toMatchObject({ code: "STALE_ATTEMPT" });
    expect(await hash(run.runId)).toBe(before);
    // legacy (P2-shaped) run
    const legacyRun = "66666666-6666-4666-8666-666666666666";
    const legacyKey = `${tenantId}:standard-tenant@1:events-service:events-service:grid-system-defaults`;
    await mongoose.connection.db.collection("provisioningruns").insertOne({ runId: legacyRun, tenantId, templateKey: "legacy-proof", templateVersion: 1, templateContentHash: templateContentHash(DEF), status: "pending", attempt: 1, steps: [{ order: 1, key: legacyKey, component: "events-service:grid-system-defaults", service: "events-service", version: 1, manifestSha256: DEF.components[1].manifestSha256, required: true, status: "pending" }], history: [] });
    expect(await h(msg(row, COMPLETED, { runId: legacyRun, stepKey: legacyKey }))).toMatchObject({ outcome: "refused", code: "INVALID_STEP_KEY" });
    await expect(orchestrator.requestNextStep({ runId: legacyRun, tenantId })).rejects.toMatchObject({ code: "LEGACY_STEP_KEY_VERSION" });
  });
});
