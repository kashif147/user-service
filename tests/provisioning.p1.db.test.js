/**
 * Phase B / P1 - PlatformTemplate + ProvisioningRun against a REAL throwaway mongod (MONGOD_BIN or `mongod` on
 * PATH; skipped otherwise): unique indexes, immutability, idempotent create-or-get (incl. concurrent requests),
 * compare-and-set step results, fail-stop, resume / replay, tenant ownership immutability, and that the control
 * plane writes nothing but its own two collections (no users, roles, permissions or tenant defaults).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");

const Tenant = require("../models/tenant.model");
const PlatformTemplate = require("../models/platformTemplate.model");
const ProvisioningRun = require("../models/provisioningRun.model");
const runs = require("../services/provisioningRunService");
const { DEFINITIONS, templateContentHash } = require("../constants/platformTemplates");

jest.setTimeout(60000);

const DEF = DEFINITIONS[0];
const PID = "6a0000000000000000000a03";
const OTHER = "6a00000000000000000000f2";
const SYSTEM = { scope: "system", principalId: null, actorId: "platform:provisioning" };
const ok = (inserted, skipped) => ({ status: "succeeded", insertedCount: inserted, skippedCount: skipped });

const mongodBin = process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const describeDb = mongodBin ? describe : describe.skip;
if (!mongodBin) console.warn("provisioning P1 real-mongod tests skipped: no mongod binary (set MONGOD_BIN)");

const publishV1 = () => PlatformTemplate.create({
  key: DEF.key, version: DEF.version, description: DEF.description, components: DEF.components.map((c) => ({ ...c })),
  contentHash: templateContentHash(DEF), status: "published", publishedAt: new Date(), publishedBy: "p1-test",
});

describeDb("provisioning P1 against a real mongod", () => {
  let mongod;
  let dbPath;
  let tenantId;
  beforeAll(async () => {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
      srv.on("error", reject);
    });
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "prov-p1-"));
    mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
    for (let i = 0; i < 160 && mongoose.connection.readyState !== 1; i += 1) {
      try {
        await mongoose.connect(`mongodb://127.0.0.1:${port}/prov-p1-test`, { serverSelectionTimeoutMS: 500 });
      } catch (_) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (mongoose.connection.readyState !== 1) throw new Error("throwaway mongod did not start");
    await PlatformTemplate.init();
    await ProvisioningRun.init();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) { const exited = new Promise((r) => mongod.once("exit", r)); mongod.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
    try {
      if (dbPath && dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true });
    } catch (_) {
      // best-effort temp cleanup
    }
  });
  beforeEach(async () => {
    const db = mongoose.connection.db;
    await db.collection("provisioningruns").deleteMany({});
    await db.collection("platformtemplates").deleteMany({});
    await db.collection("tenants").deleteMany({});
    tenantId = String(new mongoose.Types.ObjectId());
    await db.collection("tenants").insertOne({ _id: new mongoose.Types.ObjectId(tenantId), name: "DEVPROV-TEST", code: "DEVPROVTEST", status: "ACTIVE", isActive: true });
    await publishV1();
  });

  describe("PlatformTemplate", () => {
    test("published from its reviewed definition; one record per key+version", async () => {
      await expect(publishV1()).rejects.toMatchObject({ code: 11000 });
      expect(await PlatformTemplate.countDocuments()).toBe(1);
    });
    test("has no tenant: a tenantId (or any unknown field) is rejected", async () => {
      await expect(PlatformTemplate.create({ ...DEF, version: 2, tenantId, contentHash: "0".repeat(64), publishedAt: new Date(), publishedBy: "x" })).rejects.toThrow();
    });
    test("a record whose components do not match its contentHash, or reference an unregistered version, is refused", async () => {
      const bad = DEF.components.map((c, i) => (i === 0 ? { ...c, manifestSha256: "f".repeat(64) } : { ...c }));
      await expect(PlatformTemplate.create({ key: DEF.key, version: 2, components: bad, contentHash: templateContentHash({ key: DEF.key, version: 2, components: bad }), publishedAt: new Date(), publishedBy: "x" })).rejects.toThrow(/not exactly a registered component/);
      await expect(PlatformTemplate.create({ key: DEF.key, version: 3, components: DEF.components.map((c) => ({ ...c })), contentHash: "a".repeat(64), publishedAt: new Date(), publishedBy: "x" })).rejects.toThrow(/contentHash/);
    });
    test("immutable once published: components / version / hash never change; only published -> retired; never deleted", async () => {
      const q = { key: DEF.key, version: DEF.version };
      await expect(PlatformTemplate.updateOne(q, { $set: { components: [] } })).rejects.toThrow(/immutable/);
      await expect(PlatformTemplate.updateOne(q, { $set: { contentHash: "b".repeat(64) } })).rejects.toThrow(/immutable/);
      await expect(PlatformTemplate.updateOne(q, { $push: { components: DEF.components[0] } })).rejects.toThrow(/immutable/);
      await expect(PlatformTemplate.updateOne(q, { $set: { status: "published", description: "x" } })).rejects.toThrow(/immutable/);
      await expect(PlatformTemplate.deleteOne(q)).rejects.toThrow(/never deleted/);
      const doc = await PlatformTemplate.findOne(q);
      doc.description = "edited";
      await expect(doc.save()).rejects.toThrow(/immutable/); // immutable + strict "throw": refused, not silently kept
      expect((await PlatformTemplate.findOne(q).lean()).description).toBe(DEF.description);
      expect((await PlatformTemplate.updateOne(q, { $set: { status: "retired", retiredAt: new Date(), retiredBy: "p1-test" } })).modifiedCount).toBe(1);
      await expect(PlatformTemplate.updateOne(q, { $set: { status: "published" } })).rejects.toThrow(/only be retired/);
    });
  });

  describe("ProvisioningRun", () => {
    test("create-or-get is idempotent: same run, one document, created only the first time", async () => {
      const a = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
      const b = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.run.runId).toBe(a.run.runId);
      expect(await ProvisioningRun.countDocuments()).toBe(1);
      // the repeat returns the stored run untouched - not even updatedAt moves
      expect(JSON.stringify(b.run)).toBe(JSON.stringify(a.run));
      expect(a.run.createdAt).toBeInstanceOf(Date);
      expect(a.run.updatedAt.getTime()).toBe(a.run.createdAt.getTime());
      expect(a.run.steps).toHaveLength(DEF.components.length);
      expect(a.run.steps.every((s) => s.status === "pending" && s.key.startsWith(`${tenantId}:${DEF.key}@1:`))).toBe(true);
    });
    test("concurrent requests for the same tenant+version create exactly one run", async () => {
      const res = await Promise.all(Array.from({ length: 8 }, () => runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID })));
      expect(new Set(res.map((r) => r.run.runId)).size).toBe(1);
      expect(res.filter((r) => r.created)).toHaveLength(1);
      expect(await ProvisioningRun.countDocuments()).toBe(1);
    });
    test("the target must be an existing tenant by internal id; locators never resolve", async () => {
      for (const bad of ["DEVPROVTEST", "39866a06-30bc-4a89-80c6-9dd9357dd453", "example.org", "default", null]) {
        await expect(runs.createOrGetRun({ tenantId: bad, templateKey: DEF.key, templateVersion: 1, principalId: PID })).rejects.toMatchObject({ code: "INTERNAL_TENANT_ID_REQUIRED" });
      }
      await expect(runs.createOrGetRun({ tenantId: OTHER, templateKey: DEF.key, templateVersion: 1, principalId: PID })).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
      expect(await ProvisioningRun.countDocuments()).toBe(0);
    });
    test("a retired, unpublished or tampered template cannot start a run", async () => {
      await mongoose.connection.db.collection("platformtemplates").updateOne({ key: DEF.key }, { $set: { "components.0.manifestSha256": "f".repeat(64) } }); // raw tamper below the model
      await expect(runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID })).rejects.toMatchObject({ code: "TEMPLATE_INTEGRITY" });
      await expect(runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 9, principalId: PID })).rejects.toMatchObject({ code: "TEMPLATE_NOT_PUBLISHED" });
      expect(await ProvisioningRun.countDocuments()).toBe(0);
    });
    test("step results: in order only; a recorded step is never overwritten; a failed required step stops the run", async () => {
      const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
      const k = run.steps.map((s) => s.key);
      const rec = (key, result) => runs.recordStepResult({ runId: run.runId, tenantId, stepKey: key, result, actor: SYSTEM });
      await expect(rec(k[1], ok(1, 0))).rejects.toMatchObject({ code: "STEP_OUT_OF_ORDER" });
      let r = await rec(k[0], ok(4, 0));
      expect(r.status).toBe("running");
      await expect(rec(k[0], ok(0, 4))).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" }); // replay never overwrites
      r = await rec(k[1], { status: "failed", failureCode: "TIMEOUT" });
      expect(r).toMatchObject({ status: "failed", failureCode: "TIMEOUT", failedStep: k[1] });
      await expect(rec(k[2], ok(1, 0))).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" }); // no silent continue
      const s0 = r.steps[0];
      expect(s0).toMatchObject({ status: "succeeded", insertedCount: 4, skippedCount: 0, attempts: 1 });
      await expect(rec(k[2], { status: "failed", failureCode: "free text from a service" })).rejects.toMatchObject({ code: "INVALID_STEP_RESULT" });
    });
    test("resume / replay: failed -> pending (attempt 2); completed steps keep their result and cannot be redone; the run can then complete", async () => {
      const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
      const k = run.steps.map((s) => s.key);
      const rec = (key, result) => runs.recordStepResult({ runId: run.runId, tenantId, stepKey: key, result, actor: SYSTEM });
      await rec(k[0], ok(4, 0));
      await rec(k[1], { status: "failed", failureCode: "SERVICE_UNAVAILABLE" });
      await expect(runs.resumeRun({ runId: run.runId, principalId: PID })).resolves.toMatchObject({ status: "pending", attempt: 2, failureCode: null });
      await expect(runs.resumeRun({ runId: run.runId, principalId: PID })).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
      let r = await ProvisioningRun.findOne({ runId: run.runId }).lean();
      expect(r.steps[0]).toMatchObject({ status: "succeeded", insertedCount: 4 });
      expect(r.steps[1]).toMatchObject({ status: "pending", failureCode: null });
      await expect(rec(k[0], ok(0, 4))).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
      for (const key of k.slice(1)) r = await rec(key, ok(0, 1));
      expect(r.status).toBe("succeeded");
      expect(r.completedAt).toBeTruthy();
      // a later create-or-get returns the completed run unchanged - nothing is reset or re-planned
      const again = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
      expect(again).toMatchObject({ created: false, run: { runId: run.runId, status: "succeeded", attempt: 2 } });
      expect(again.run.steps.map((s) => s.status)).toEqual(Array(k.length).fill("succeeded"));
      expect(r.history.map((h) => h.action)).toEqual(["created", "step-recorded", "failed", "resumed", ...Array(k.length - 2).fill("step-recorded"), "succeeded"]);
    });
    test("ownership is immutable: the run's tenant can never be changed, unset or nulled", async () => {
      const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
      await expect(ProvisioningRun.updateOne({ runId: run.runId }, { $set: { tenantId: OTHER } })).rejects.toMatchObject({ code: "TENANT_IMMUTABLE" });
      await expect(ProvisioningRun.updateOne({ runId: run.runId, tenantId }, { $unset: { tenantId: 1 } })).rejects.toMatchObject({ code: "TENANT_IMMUTABLE" });
      await expect(ProvisioningRun.updateOne({ runId: run.runId, tenantId }, { $set: { tenantId: null } })).rejects.toMatchObject({ code: "TENANT_IMMUTABLE" });
      const doc = await ProvisioningRun.findOne({ runId: run.runId });
      doc.tenantId = OTHER;
      await expect(doc.save()).rejects.toThrow(/immutable/);
      expect((await ProvisioningRun.findOne({ runId: run.runId }).lean()).tenantId).toBe(tenantId);
      await expect(ProvisioningRun.deleteOne({ runId: run.runId })).rejects.toThrow(/never deleted/);
    });
    test("no secrets or free-form data: unknown fields are rejected", async () => {
      await expect(ProvisioningRun.create({ runId: "11111111-2222-4333-8444-555555555555", tenantId, templateKey: DEF.key, templateVersion: 1, templateContentHash: "a".repeat(64), steps: [], createdBy: { scope: "platform", principalId: PID }, token: "x" })).rejects.toThrow();
    });
    test("the control plane writes only its own collections: no users, roles, permissions, tenant defaults or tenantless rows", async () => {
      const { run } = await runs.createOrGetRun({ tenantId, templateKey: DEF.key, templateVersion: 1, principalId: PID });
      await runs.recordStepResult({ runId: run.runId, tenantId, stepKey: run.steps[0].key, result: ok(1, 0), actor: SYSTEM });
      const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name).sort();
      expect(names).toEqual(["platformtemplates", "provisioningruns", "tenants"]);
      expect(await mongoose.connection.db.collection("tenants").countDocuments()).toBe(1);
      expect(await ProvisioningRun.countDocuments({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] })).toBe(0);
    });
  });
});

test("Tenant model loads (lookup by _id only in the run service)", () => {
  expect(typeof Tenant.findById).toBe("function");
});
