/**
 * Stage 5c-2 Test Connection result write against a real MongoDB (the Tenant model's positional
 * update of one authentication connection).
 *
 * Runs only when STAGE5B_MONGO_URI points at a DISPOSABLE MongoDB (same variable as the Stage 5b /
 * 5c database suites); skipped otherwise. The test database is dropped at the end.
 */
const mongoose = require("mongoose");

const URI = process.env.STAGE5B_MONGO_URI;
const run = URI ? describe : describe.skip;

const ENTRA = "Entra ID (Azure AD)";
const DIR = "11111111-2222-3333-4444-555555555555";
const DIR2 = "22222222-3333-4444-5555-666666666666";

run("Test Connection result write against MongoDB", () => {
  let Tenant;
  let record;
  const tenantId = new mongoose.Types.ObjectId();
  const connId = new mongoose.Types.ObjectId();
  const otherConnId = new mongoose.Types.ObjectId();
  const roleId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(URI, { dbName: `stage5c2_test_${Date.now()}` });
    Tenant = require("../models/tenant.model");
    ({ recordConnectionTestResult: record } = require("../handlers/entraConnect.handler"));
  });
  beforeEach(async () => {
    await Tenant.collection.deleteMany({});
    // Raw insert: only the fields that matter here, exactly as stored.
    await Tenant.collection.insertOne({
      _id: tenantId,
      name: "Org A",
      code: "ORGA",
      isActive: true,
      authenticationConnections: [
        { _id: connId, connectionType: ENTRA, directoryId: DIR, isActive: false, autoProvisionUsers: true, defaultRoleId: roleId, connectedAt: new Date("2026-10-16T10:00:00Z"), connectedBy: "u1" },
        { _id: otherConnId, connectionType: ENTRA, directoryId: DIR2, isActive: true, autoProvisionUsers: false },
      ],
    });
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const raw = async () => Tenant.collection.findOne({ _id: tenantId });
  const without = (c, keys) => Object.fromEntries(Object.entries(c).filter(([k]) => !keys.includes(k)));

  test("writes only lastTestedAt / lastTestResult {ok, code} on the addressed connection", async () => {
    const before = await raw();
    const at = await record({ tenantId: String(tenantId), connectionId: String(connId), directoryId: DIR, result: { ok: false, code: "APP_NOT_CONSENTED" } });
    const after = await raw();
    const c = after.authenticationConnections[0];
    expect(c.lastTestResult).toEqual({ ok: false, code: "APP_NOT_CONSENTED" });
    expect(c.lastTestedAt.getTime()).toBe(at.getTime());
    expect(without(c, ["lastTestedAt", "lastTestResult"])).toEqual(before.authenticationConnections[0]);
    expect(after.authenticationConnections[1]).toEqual(before.authenticationConnections[1]);
    expect(without(after, ["authenticationConnections", "updatedAt"])).toEqual(without(before, ["authenticationConnections", "updatedAt"]));
  });

  test("a later success replaces the result (no extra keys stored)", async () => {
    await record({ tenantId: String(tenantId), connectionId: String(connId), directoryId: DIR, result: { ok: false, code: "MICROSOFT_UNAVAILABLE" } });
    await record({ tenantId: String(tenantId), connectionId: String(connId), directoryId: DIR, result: { ok: true, code: "CONNECTED" } });
    const c = (await raw()).authenticationConnections[0];
    expect(c.lastTestResult).toEqual({ ok: true, code: "CONNECTED" });
  });

  test("directory changed (or connection gone, or another tenant) -> CONNECTION_CHANGED, nothing written", async () => {
    const before = await raw();
    for (const args of [
      { tenantId: String(tenantId), connectionId: String(connId), directoryId: DIR2 },
      { tenantId: String(tenantId), connectionId: String(new mongoose.Types.ObjectId()), directoryId: DIR },
      { tenantId: String(new mongoose.Types.ObjectId()), connectionId: String(connId), directoryId: DIR },
    ]) {
      await expect(record({ ...args, result: { ok: true, code: "CONNECTED" } })).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    }
    expect(await raw()).toEqual(before);
  });

  test("an unknown result code or extra keys are never stored", async () => {
    await expect(
      record({ tenantId: String(tenantId), connectionId: String(connId), directoryId: DIR, result: { ok: false, code: "AADSTS7000215 raw text" } })
    ).rejects.toBeTruthy();
    await record({ tenantId: String(tenantId), connectionId: String(connId), directoryId: DIR, result: { ok: true, code: "CONNECTED", token: "x", step: "token" } });
    expect(Object.keys((await raw()).authenticationConnections[0].lastTestResult).sort()).toEqual(["code", "ok"]);
  });
});
