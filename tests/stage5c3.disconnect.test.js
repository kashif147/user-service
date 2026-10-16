/**
 * Stage 5c-3: "Disconnect Microsoft Entra" (backend).
 *
 *  POST /tenants/:id/auth-connections/:connectionId/disconnect
 *    -> { status: "disconnected", directoryId, disconnectedAt, disconnectedBy }
 *
 * One transaction: the connection becomes inactive (+ disconnectedAt / disconnectedBy) and its
 * verified entra-admin-sign-in DirectoryClaim becomes revoked (+ revokedAt / revokedBy, same time).
 * Revoked is terminal audit history; a reconnect creates a NEW verified claim. A disconnected
 * connection cannot be tested (CONNECTION_DISCONNECTED) or re-activated by an edit until it is
 * reconnected. Platform-managed claims (dev-exception, platform) are never disconnected.
 *
 * Tenant and claim stores are in memory; the transaction runner here snapshots both stores and
 * restores them on error (the real transaction is proven in tests/stage5c3.disconnect.mongo.test.js,
 * the route chain in tests/stage5c3.disconnect.routes.test.js). New modules / functions are reached
 * inside the tests so each fails on its own against older code.
 */
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));

const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const HOME_DIR = process.env.AZURE_AD_TENANT_ID; // tests/setupEntraEnv.js (also the DEV shared directory)
const DIR_A = "11111111-2222-3333-4444-555555555555";
const DIR_B = "22222222-3333-4444-5555-666666666666";
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const ADMIN_OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const ADMIN_USER = "psUserA1";
const DEV_VARS = { DEPLOYMENT_ENV: "dev", ENTRA_ALLOW_SHARED_DIRECTORY: "true", ENTRA_SHARED_DIRECTORY_ALLOWLIST: HOME_DIR };

// ---- in-memory tenants ----
const mockTenants = [];
const clone = (v) => JSON.parse(JSON.stringify(v));
jest.mock("../models/tenant.model", () => ({
  findOne: (q) => ({
    select: () => ({
      lean: async () => {
        const t = mockTenants.find((x) => x._id === String(q._id) && x.isActive !== false);
        return t ? clone(t) : null;
      },
    }),
  }),
  find: () => ({ select: () => ({ lean: async () => [] }) }),
  updateOne: jest.fn(async (filter, update) => {
    const t = mockTenants.find((x) => x._id === String(filter._id));
    const m = filter.authenticationConnections.$elemMatch;
    const c = t?.authenticationConnections.find(
      (x) => x._id === String(m._id) && x.connectionType === m.connectionType && x.directoryId === m.directoryId
    );
    if (!c) return { matchedCount: 0, modifiedCount: 0 };
    for (const [k, v] of Object.entries(update.$set)) c[k.replace("authenticationConnections.$.", "")] = v;
    return { matchedCount: 1, modifiedCount: 1 };
  }),
}));
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "signed.jwt" }) }));
jest.mock("../services/cacheService", () =>
  new Proxy({}, { get: (_t, k) => (k === "__esModule" || k === "then" ? undefined : jest.fn().mockResolvedValue(null)) })
);

const axios = require("axios");
const Tenant = require("../models/tenant.model");
const AzureADHandler = require("../handlers/azure.ad.handler");
const { makeTestKeypairAndJwks, signTestJwt } = require("./helpers/testJwt");

const load = {
  handler: () => require("../handlers/entraConnect.handler"),
  connect: () => require("../helpers/entraConnect"),
  service: () => require("../helpers/directoryClaimService"),
  gate: () => require("../helpers/directoryClaimGate"),
  resolver: () => require("../helpers/connectionAuthConfig"),
  model: () => require("../models/directoryClaim.model"),
  rules: () => require("../helpers/connectionDefaultRole"),
  controller: () => require("../controllers/tenant.controller"),
};

// ---- in-memory DirectoryClaim store behind the real model (validation and hooks run) ----
const claims = [];
const matches = (c, q) =>
  Object.entries(q).every(([k, v]) =>
    v && typeof v === "object" && Array.isArray(v.$in) ? v.$in.map(String).includes(String(c[k])) : String(c[k]) === String(v)
  );
let claimSeq = 0;
function stubClaims() {
  const DirectoryClaim = load.model();
  jest.spyOn(DirectoryClaim, "init").mockResolvedValue(undefined);
  jest.spyOn(DirectoryClaim, "find").mockImplementation((q) => ({ lean: async () => clone(claims.filter((c) => matches(c, q))) }));
  jest.spyOn(DirectoryClaim, "exists").mockImplementation(async () => null);
  jest.spyOn(DirectoryClaim, "findOne").mockImplementation((q) => {
    const hit = claims.find((c) => matches(c, q));
    const doc = hit ? DirectoryClaim.hydrate(clone(hit)) : null;
    return { lean: async () => (hit ? clone(hit) : null), then: (ok, ko) => Promise.resolve(doc).then(ok, ko) };
  });
  const activeConflict = (d) =>
    ["pending", "verified"].includes(d.status) &&
    claims.some((c) => c._id !== String(d._id) && ["pending", "verified"].includes(c.status) && c.connectionId === d.connectionId);
  jest.spyOn(DirectoryClaim, "create").mockImplementation(async (data) => {
    const doc = new DirectoryClaim(data);
    await doc.validate();
    if (activeConflict(doc)) throw Object.assign(new Error("E11000"), { code: 11000 });
    claims.push(clone(doc.toObject()));
    return doc;
  });
  jest.spyOn(DirectoryClaim.prototype, "save").mockImplementation(async function save() {
    await this.validate();
    const i = claims.findIndex((c) => c._id === String(this._id));
    claims[i] = clone(this.toObject());
    return this;
  });
  return DirectoryClaim;
}
// Simulated transaction: snapshot both stores, restore them if the work throws.
async function snapshotTransaction(work) {
  const t = clone(mockTenants);
  const c = clone(claims);
  try {
    return await work({ id: "test-session" });
  } catch (e) {
    mockTenants.splice(0, mockTenants.length, ...t);
    claims.splice(0, claims.length, ...c);
    throw e;
  }
}

const entraConn = (id, dir, extra = {}) => ({
  _id: id,
  connectionType: ENTRA,
  directoryId: dir,
  isActive: true,
  autoProvisionUsers: true,
  defaultRoleId: "role0000000000000000000a",
  connectedAt: "2026-10-16T10:00:00.000Z",
  connectedBy: "psUserA0",
  lastTestedAt: "2026-10-16T11:00:00.000Z",
  lastTestResult: { ok: true, code: "CONNECTED" },
  ...extra,
});
const adminClaim = (tenantId, connectionId, dir, extra = {}) => ({
  _id: require("crypto").createHash("md5").update(`claim:${tenantId}:${connectionId}:${dir}`).digest("hex").slice(0, 24),
  connectionType: ENTRA,
  directoryId: dir,
  tenantId,
  connectionId,
  status: "verified",
  method: "entra-admin-sign-in",
  sharedDirectoryException: false,
  claimedAt: "2026-10-16T10:00:00.000Z",
  claimedBy: "user:psUserA0",
  verifiedAt: "2026-10-16T10:00:00.000Z",
  verifiedBy: "user:psUserA0",
  verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: GLOBAL_ADMIN },
  revokedAt: null,
  revokedBy: null,
  ...extra,
});
const devClaim = (tenantId, connectionId) =>
  adminClaim(tenantId, connectionId, HOME_DIR, { method: "dev-exception", sharedDirectoryException: true, claimedBy: "platform:dev-backfill", verifiedBy: "platform:dev-backfill", verificationEvidence: null });
const platformClaim = (tenantId, connectionId, dir) =>
  adminClaim(tenantId, connectionId, dir, { method: "platform", claimedBy: "platform:ops", verifiedBy: "platform:ops", verificationEvidence: null });

const disconnect = (over = {}) => load.handler().disconnectConnection({ tenantId: TENANT_A, connectionId: "connA", userId: ADMIN_USER, ...over });
const connA = () => mockTenants[0].authenticationConnections[0];
const rejectsCode = async (p, code) => {
  let err = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toMatchObject({ code });
  return err;
};
const logged = () =>
  [console.log, console.info, console.warn, console.error]
    .flatMap((fn) => fn.mock.calls)
    .map((args) => args.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "))
    .join("\n");

let kp;
beforeAll(async () => {
  kp = await makeTestKeypairAndJwks();
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENTRA_CRM_MULTI_DIRECTORY;
  for (const k of Object.keys(DEV_VARS)) delete process.env[k];
  claims.length = 0;
  mockTenants.length = 0;
  mockTenants.push(
    {
      _id: TENANT_A,
      code: "ORGA",
      isActive: true,
      authenticationConnections: [entraConn("connA", DIR_A), { _id: "b2cA", connectionType: B2C, directoryId: "x", isActive: true }],
    },
    { _id: TENANT_B, code: "ORGB", isActive: true, authenticationConnections: [entraConn("connB", DIR_B)] }
  );
  claims.push(adminClaim(TENANT_A, "connA", DIR_A), adminClaim(TENANT_B, "connB", DIR_B));
  for (const fn of ["log", "info", "warn", "error"]) jest.spyOn(console, fn).mockImplementation(() => {});
  stubClaims();
  load.handler()._setTransactionRunnerForTests(snapshotTransaction);
  load.connect()._setJwksForTests(kp.jwks, load.resolver().resolveEntraConnectConfig().jwksUri);
});
afterEach(() => {
  for (const k of Object.keys(DEV_VARS)) delete process.env[k];
  load.handler()._setTransactionRunnerForTests?.(null);
  load.connect()._setJwksForTests(null);
  jest.restoreAllMocks();
});

describe("model: revoked state", () => {
  test("statuses include revoked; active statuses are pending + verified", () => {
    expect(load.model().CLAIM_STATUSES).toEqual(["pending", "verified", "revoked"]);
    expect(load.model().ACTIVE_CLAIM_STATUSES).toEqual(["pending", "verified"]);
  });

  test("revoked requires revokedAt + revokedBy; pending / verified may not carry them", async () => {
    const DirectoryClaim = load.model();
    const base = { connectionType: ENTRA, directoryId: DIR_A, tenantId: TENANT_A, connectionId: "connA", method: "entra-admin-sign-in", claimedBy: "user:x" };
    const errs = async (d) => {
      try {
        await new DirectoryClaim(d).validate();
        return [];
      } catch (e) {
        return Object.keys(e.errors);
      }
    };
    const verified = { ...base, status: "verified", verifiedAt: new Date(), verifiedBy: "user:x" };
    expect(await errs({ ...verified, status: "revoked" })).toContain("revokedAt");
    expect(await errs({ ...verified, status: "revoked", revokedAt: new Date(), revokedBy: "user:y" })).toEqual([]);
    expect(await errs({ ...verified, revokedAt: new Date(), revokedBy: "user:y" })).toContain("revokedAt");
    expect(await errs({ ...base, status: "pending", revokedAt: new Date() })).toContain("revokedAt");
  });

  test("revoked is terminal; only a verified claim can be revoked, and revoking changes only status/revokedAt/revokedBy", async () => {
    const DirectoryClaim = load.model();
    const revoked = DirectoryClaim.hydrate(adminClaim(TENANT_A, "connA", DIR_A, { status: "revoked", revokedAt: new Date(), revokedBy: "user:x" }));
    revoked.status = "verified";
    await expect(revoked.validate()).rejects.toMatchObject({ errors: { status: expect.anything() } });
    const pending = DirectoryClaim.hydrate(adminClaim(TENANT_A, "connA", DIR_A, { status: "pending", verifiedAt: null, verifiedBy: null }));
    Object.assign(pending, { status: "revoked", revokedAt: new Date(), revokedBy: "user:x" });
    await expect(pending.validate()).rejects.toMatchObject({ errors: { status: expect.anything() } });
    const v = DirectoryClaim.hydrate(adminClaim(TENANT_A, "connA", DIR_A));
    Object.assign(v, { status: "revoked", revokedAt: new Date(), revokedBy: "user:x", verifiedBy: "user:someone-else" });
    await expect(v.validate()).rejects.toMatchObject({ errors: { status: expect.anything() } });
  });

  test("index design: active-claim partial indexes under new names; uniq_verified_directory unchanged", () => {
    const byName = Object.fromEntries(load.model().schema.indexes().map(([fields, opts]) => [opts.name, { fields, opts }]));
    const active = { status: { $in: ["pending", "verified"] } };
    expect(byName.uniq_active_claim_per_connection).toEqual({ fields: { connectionType: 1, connectionId: 1 }, opts: expect.objectContaining({ unique: true, partialFilterExpression: active }) });
    expect(byName.uniq_active_claim_per_tenant_directory).toEqual({
      fields: { connectionType: 1, directoryId: 1, tenantId: 1 },
      opts: expect.objectContaining({ unique: true, partialFilterExpression: active }),
    });
    expect(byName.uniq_verified_directory.opts.partialFilterExpression).toEqual({ status: "verified", sharedDirectoryException: false });
    expect(byName.uniq_claim_per_connection).toBeUndefined();
    expect(byName.uniq_claim_per_tenant_directory).toBeUndefined();
  });
});

describe("disconnect: preconditions", () => {
  test("A own tenant admin disconnects the verified connection", async () => {
    const out = await disconnect();
    expect(out).toEqual({ status: "disconnected", directoryId: DIR_A, disconnectedAt: expect.any(Date), disconnectedBy: ADMIN_USER });
  });

  test("D missing connection / other organisation's connection -> CONNECTION_NOT_FOUND, nothing written", async () => {
    const before = clone({ mockTenants, claims });
    await rejectsCode(disconnect({ connectionId: "nope" }), "CONNECTION_NOT_FOUND");
    await rejectsCode(disconnect({ connectionId: "connB" }), "CONNECTION_NOT_FOUND");
    await rejectsCode(disconnect({ tenantId: "dddddddddddddddddddddddd" }), "CONNECTION_NOT_FOUND");
    expect(clone({ mockTenants, claims })).toEqual(before);
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test("E non-Entra -> NOT_ENTRA_CONNECTION; invalid directory -> INVALID_DIRECTORY", async () => {
    await rejectsCode(disconnect({ connectionId: "b2cA" }), "NOT_ENTRA_CONNECTION");
    connA().directoryId = "common";
    await rejectsCode(disconnect(), "INVALID_DIRECTORY");
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test("F no verified claim (none / pending / revoked / other directory) -> NOT_CONNECTED, nothing written", async () => {
    for (const set of [
      [],
      [adminClaim(TENANT_A, "connA", DIR_A, { status: "pending", verifiedAt: null, verifiedBy: null })],
      [adminClaim(TENANT_A, "connA", DIR_A, { status: "revoked", revokedAt: "2026-10-16T12:00:00.000Z", revokedBy: "user:x" })],
      [adminClaim(TENANT_A, "connA", DIR_B)],
    ]) {
      claims.length = 0;
      claims.push(...set);
      const before = clone({ mockTenants, claims });
      await rejectsCode(disconnect(), "NOT_CONNECTED");
      expect(clone({ mockTenants, claims })).toEqual(before);
    }
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test("second Disconnect -> NOT_CONNECTED (never a silent 200)", async () => {
    await disconnect();
    const before = clone({ mockTenants, claims });
    await rejectsCode(disconnect(), "NOT_CONNECTED");
    expect(clone({ mockTenants, claims })).toEqual(before);
  });

  test("V platform-managed claims are refused and untouched: dev-exception -> DIRECTORY_SHARED_EXCEPTION, platform -> CLAIM_METHOD_CONFLICT", async () => {
    Object.assign(process.env, DEV_VARS);
    connA().directoryId = HOME_DIR;
    claims.length = 0;
    claims.push(devClaim(TENANT_A, "connA"), platformClaim(TENANT_B, "connB", DIR_B));
    const before = clone({ mockTenants, claims });
    await rejectsCode(disconnect(), "DIRECTORY_SHARED_EXCEPTION");
    await rejectsCode(disconnect({ tenantId: TENANT_B, connectionId: "connB" }), "CLAIM_METHOD_CONFLICT");
    expect(clone({ mockTenants, claims })).toEqual(before);
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test("an authenticated actor is required", async () => {
    await rejectsCode(disconnect({ userId: undefined }), "ACTOR_REQUIRED");
  });
});

describe("disconnect: effect", () => {
  test("G connection inactive + claim revoked; one timestamp for disconnectedAt and revokedAt; actors recorded", async () => {
    const out = await disconnect();
    const c = connA();
    expect(c.isActive).toBe(false);
    expect(c.disconnectedAt).toBe(out.disconnectedAt);
    expect(c.disconnectedBy).toBe(ADMIN_USER);
    const claim = claims.find((x) => x.connectionId === "connA");
    expect(claim).toMatchObject({ status: "revoked", revokedBy: `user:${ADMIN_USER}` });
    expect(new Date(claim.revokedAt).getTime()).toBe(out.disconnectedAt.getTime());
  });

  test("J/K/L/M directory, provisioning, default role, connect and test metadata preserved; other connections untouched", async () => {
    const keep = ["_id", "connectionType", "directoryId", "autoProvisionUsers", "defaultRoleId", "connectedAt", "connectedBy", "lastTestedAt", "lastTestResult"];
    const pick = (x) => Object.fromEntries(keep.map((k) => [k, x[k]]));
    const before = pick(clone(connA()));
    const others = clone([mockTenants[0].authenticationConnections[1], mockTenants[1]]);
    await disconnect();
    expect(pick(clone(connA()))).toEqual(before);
    expect(clone([mockTenants[0].authenticationConnections[1], mockTenants[1]])).toEqual(others);
    const [, update] = Tenant.updateOne.mock.calls[0];
    expect(Object.keys(update.$set).sort()).toEqual([
      "authenticationConnections.$.disconnectedAt",
      "authenticationConnections.$.disconnectedBy",
      "authenticationConnections.$.isActive",
    ]);
  });

  test("claim history preserved: only status / revokedAt / revokedBy change", async () => {
    const before = clone(claims.find((x) => x.connectionId === "connA"));
    await disconnect();
    const after = clone(claims.find((x) => x.connectionId === "connA"));
    const strip = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => !["status", "revokedAt", "revokedBy", "updatedAt"].includes(k)));
    expect(strip(after)).toEqual(strip(before));
    expect(claims.find((x) => x.connectionId === "connB")).toEqual(adminClaim(TENANT_B, "connB", DIR_B));
  });

  test("H/I no user or role model is touched", () => {
    const fs = require("fs");
    const path = require("path");
    for (const f of ["handlers/entraConnect.handler.js", "helpers/directoryClaimService.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/models\/(user|role)\.model|require\(["'][^"']*(user|role)\.handler/);
    }
  });

  test("S claim write failure -> transaction aborted: connection unchanged, claim unchanged", async () => {
    const before = clone({ mockTenants, claims });
    load.model().prototype.save.mockImplementationOnce(async () => {
      throw new Error("simulated claim write failure");
    });
    await expect(disconnect()).rejects.toThrow("simulated claim write failure");
    expect(clone({ mockTenants, claims })).toEqual(before);
  });

  test("S connection changed before the write (directory edited) -> CONNECTION_CHANGED, claim unchanged", async () => {
    const before = clone(claims);
    Tenant.updateOne.mockImplementationOnce(async () => ({ matchedCount: 0, modifiedCount: 0 }));
    await rejectsCode(disconnect(), "CONNECTION_CHANGED");
    expect(clone(claims)).toEqual(before);
    expect(connA().isActive).toBe(true);
  });

  test("T body / query identity values are ignored by the controller", async () => {
    const res = { statusCode: null, body: null };
    res.status = (s) => ((res.statusCode = s), res);
    res.json = (b) => ((res.body = b), res);
    res.success = (data) => res.status(200).json({ status: "success", data });
    res.sendAppError = (e) => res.status(e.status).json({ error: { code: e.code, message: e.message } });
    res.sendInternalError = (m) => res.status(500).json({ error: { message: m } });
    await load.controller().disconnectEntraConnection(
      {
        params: { id: TENANT_A, connectionId: "connA" },
        body: { tenantId: TENANT_B, connectionId: "connB", directoryId: DIR_B, disconnectedBy: "attacker", disconnectedAt: "2000-01-01" },
        query: { tenantId: TENANT_B, directoryId: DIR_B },
        ctx: { userId: ADMIN_USER, tenantId: TENANT_A },
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ status: "disconnected", directoryId: DIR_A, disconnectedAt: expect.any(Date), disconnectedBy: ADMIN_USER });
    expect(Object.keys(res.body.data).sort()).toEqual(["directoryId", "disconnectedAt", "disconnectedBy", "status"]);
    expect(mockTenants[1].authenticationConnections[0].isActive).toBe(true);
    expect(claims.find((x) => x.connectionId === "connB").status).toBe("verified");
  });

  test("controller maps the refusals to safe codes", async () => {
    const call = async (params) => {
      const res = { statusCode: null, body: null };
      res.status = (s) => ((res.statusCode = s), res);
      res.json = (b) => ((res.body = b), res);
      res.success = (data) => res.status(200).json({ data });
      res.sendAppError = (e) => res.status(e.status).json({ error: { code: e.code } });
      res.sendInternalError = () => res.status(500).json({});
      await load.controller().disconnectEntraConnection({ params, body: {}, query: {}, ctx: { userId: ADMIN_USER } }, res);
      return res;
    };
    expect((await call({ id: TENANT_A, connectionId: "nope" })).statusCode).toBe(404);
    expect((await call({ id: TENANT_A, connectionId: "b2cA" })).statusCode).toBe(400);
    await disconnect();
    const again = await call({ id: TENANT_A, connectionId: "connA" });
    expect(again.statusCode).toBe(409);
    expect(again.body.error.code).toBe("NOT_CONNECTED");
  });

  test("no token, evidence or internal configuration in the response or logs", async () => {
    const out = await disconnect();
    expect(JSON.stringify(out)).not.toMatch(/verificationEvidence|roleTemplateId|directoryUserId|appRef|clientId|scope|issuer|audience|secret/i);
    expect(logged()).not.toMatch(/verificationEvidence|roleTemplateId|directoryUserId|secret/i);
  });
});

describe("after disconnect: claim gate, Test Connection, activation, status", () => {
  test("Q the revoked claim satisfies no gate (multi-directory mode) and no Test Connection precondition", async () => {
    await disconnect();
    process.env.ENTRA_CRM_MULTI_DIRECTORY = "true";
    try {
      await rejectsCode(
        load.gate().assertConnectionDirectoryClaim({ tenantId: TENANT_A, connection: { ...connA(), isActive: true }, connectionId: "connA" }),
        "DIRECTORY_NOT_CLAIMED"
      );
    } finally {
      delete process.env.ENTRA_CRM_MULTI_DIRECTORY;
    }
    await expect(load.service().findValidConnectionClaim({ tenantId: TENANT_A, connectionId: "connA", directoryId: DIR_A })).resolves.toBeNull();
  });

  test("O Test Connection on a disconnected connection -> CONNECTION_DISCONNECTED: no Microsoft call, nothing written", async () => {
    await disconnect();
    Tenant.updateOne.mockClear();
    const before = clone(connA());
    await rejectsCode(load.handler().testConnection({ tenantId: TENANT_A, connectionId: "connA" }), "CONNECTION_DISCONNECTED");
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(Tenant.updateOne).not.toHaveBeenCalled();
    expect(clone(connA())).toEqual(before);
  });

  test("a never-claimed connection is still tested with a recorded DIRECTORY_NOT_CLAIMED (Stage 5c-2 unchanged)", async () => {
    claims.length = 0;
    await expect(load.handler().testConnection({ tenantId: TENANT_A, connectionId: "connA" })).resolves.toMatchObject({ ok: false, code: "DIRECTORY_NOT_CLAIMED" });
    expect(Tenant.updateOne).toHaveBeenCalledTimes(1);
  });

  test("activation guard: re-activating a disconnected connection -> 409 CONNECTION_DISCONNECTED, switch OFF or ON", async () => {
    await disconnect();
    const rules = load.rules();
    for (const multi of [undefined, "true"]) {
      if (multi) process.env.ENTRA_CRM_MULTI_DIRECTORY = multi;
      else delete process.env.ENTRA_CRM_MULTI_DIRECTORY;
      const err = await rejectsCode(
        rules.assertConnectionWritable(TENANT_A, { ...rules.pickConnectionFields(connA()), autoProvisionUsers: false, defaultRoleId: undefined, isActive: true }, { connectionId: "connA", stored: connA() }),
        "CONNECTION_DISCONNECTED"
      );
      expect(err).toBeInstanceOf(rules.ConnectionValidationError);
      expect(err.status).toBe(409);
      expect(err.message).toBe("Reconnect Microsoft Entra before activating this connection.");
    }
    delete process.env.ENTRA_CRM_MULTI_DIRECTORY;
    // saving it inactive (other edits) is still allowed
    await expect(
      rules.assertConnectionWritable(TENANT_A, { ...rules.pickConnectionFields(connA()), autoProvisionUsers: false, defaultRoleId: undefined, isActive: false }, { connectionId: "connA", stored: connA() })
    ).resolves.toBeUndefined();
  });

  test("activation guard does not affect never-disconnected connections", async () => {
    // The guard reads this organisation's claim history for the directory (it must, because a
    // disconnected connection may have been deleted and replaced); without revoked history the
    // outcome is unchanged.
    const rules = load.rules();
    await expect(
      rules.assertConnectionWritable(TENANT_A, { ...rules.pickConnectionFields(connA()), autoProvisionUsers: false, defaultRoleId: undefined, isActive: true }, { connectionId: "connA", stored: connA() })
    ).resolves.toBeUndefined();
    claims.length = 0;
    await expect(
      rules.assertConnectionWritable(TENANT_A, { connectionType: ENTRA, directoryId: DIR_A, isActive: true, autoProvisionUsers: false })
    ).resolves.toBeUndefined();
  });

  test("disconnectedAt / disconnectedBy are server-managed: never taken from a request, kept on edits", async () => {
    const rules = load.rules();
    expect(rules.SERVER_MANAGED_CONNECTION_FIELDS).toEqual(expect.arrayContaining(["disconnectedAt", "disconnectedBy"]));
    expect(rules.pickConnectionFields({ isActive: false, disconnectedAt: "2000-01-01", disconnectedBy: "attacker" })).toEqual({ isActive: false });
    await disconnect();
    const stored = clone(connA());
    const out = await rules.prepareConnectionsForWrite(
      TENANT_A,
      [{ ...stored, autoProvisionUsers: false, defaultRoleId: undefined, disconnectedAt: "2000-01-01", disconnectedBy: "attacker" }, mockTenants[0].authenticationConnections[1]],
      mockTenants[0].authenticationConnections
    );
    expect(new Date(out[0].disconnectedAt).toISOString()).toBe(new Date(stored.disconnectedAt).toISOString());
    expect(out[0].disconnectedBy).toBe(ADMIN_USER);
  });

  test("U status: disconnected (with audit fields); not_connected once the directory is edited", async () => {
    await disconnect();
    const s = await load.handler().getConnectionStatus({ tenantId: TENANT_A, connectionId: "connA" });
    expect(s).toMatchObject({ status: "disconnected", isActive: false, disconnectedBy: ADMIN_USER, directoryId: DIR_A });
    expect(s.disconnectedAt).toBeTruthy();
    expect(JSON.stringify(s)).not.toMatch(/verificationEvidence|roleTemplateId|directoryUserId|revokedBy/);
    connA().directoryId = DIR_B;
    await expect(load.handler().getConnectionStatus({ tenantId: TENANT_A, connectionId: "connA" })).resolves.toMatchObject({ status: "not_connected" });
  });

  test("U status lookup: an active claim always wins over revoked history; revoked history sorts by revokedAt then _id", () => {
    const pick = load.service().pickConnectionClaim;
    const r = (id, at) => adminClaim(TENANT_A, "connA", DIR_A, { _id: id, status: "revoked", revokedAt: at, revokedBy: "user:x" });
    const active = adminClaim(TENANT_A, "connA", DIR_A, { _id: "zzzz" });
    expect(pick([r("a", "2026-10-16T12:00:00Z"), active, r("b", "2026-10-16T13:00:00Z")])._id).toBe("zzzz");
    expect(pick([r("a", "2026-10-16T12:00:00Z"), r("b", "2026-10-16T13:00:00Z")])._id).toBe("b");
    expect(pick([r("a", "2026-10-16T13:00:00Z"), r("b", "2026-10-16T13:00:00Z")])._id).toBe("b");
    expect(pick([r("b", "2026-10-16T13:00:00Z"), r("a", "2026-10-16T13:00:00Z")])._id).toBe("b");
    expect(pick([])).toBeNull();
  });
});

describe("activation guard: tenant + directory revoked history (delete / recreate bypass)", () => {
  // A connection that is NOT the disconnected one: a new or replacement connection (no stored record).
  const newActive = (dir, extra = {}) => ({ connectionType: ENTRA, directoryId: dir, isActive: true, autoProvisionUsers: false, ...extra });
  const write = (tenantId, conn, opts) => load.rules().assertConnectionWritable(tenantId, conn, opts);

  test("1 disconnect, then a NEW active connection for the same tenant + directory -> 409 CONNECTION_DISCONNECTED", async () => {
    await disconnect();
    const err = await rejectsCode(write(TENANT_A, newActive(DIR_A)), "CONNECTION_DISCONNECTED");
    expect(err.status).toBe(409);
    expect(err.message).toBe("Reconnect Microsoft Entra before activating this connection.");
  });

  test("2 the replacement may be created INACTIVE", async () => {
    await disconnect();
    await expect(write(TENANT_A, newActive(DIR_A, { isActive: false }))).resolves.toBeUndefined();
  });

  test("3 activating a replacement (stored, never disconnected itself) before Connect -> 409", async () => {
    await disconnect();
    const replacement = { _id: "connR", ...newActive(DIR_A, { isActive: false }) };
    await rejectsCode(write(TENANT_A, { ...replacement, isActive: true }, { connectionId: "connR", stored: replacement }), "CONNECTION_DISCONNECTED");
  });

  test("5 after Connect the replacement has its own verified claim -> activation allowed", async () => {
    await disconnect();
    claims.push(adminClaim(TENANT_A, "connR", DIR_A));
    const replacement = { _id: "connR", ...newActive(DIR_A, { isActive: false }) };
    await expect(write(TENANT_A, { ...replacement, isActive: true }, { connectionId: "connR", stored: replacement })).resolves.toBeUndefined();
  });

  test("8 revoked history for directory A does not block directory B (switch-OFF semantics unchanged)", async () => {
    await disconnect();
    const DIR_C = "33333333-4444-5555-6666-777777777777";
    await expect(write(TENANT_A, newActive(DIR_C))).resolves.toBeUndefined();
  });

  test("9 another organisation's revoked claim does not trigger this organisation's guard", async () => {
    await load.handler().disconnectConnection({ tenantId: TENANT_B, connectionId: "connB", userId: "psUserB1" });
    await expect(write(TENANT_A, newActive(DIR_B))).resolves.toBeUndefined();
    await rejectsCode(write(TENANT_B, newActive(DIR_B)), "CONNECTION_DISCONNECTED");
  });

  test("10 spoofing does not bypass it: directory case / whitespace variants and extra body fields", async () => {
    await disconnect();
    await rejectsCode(write(TENANT_A, newActive(DIR_A.toUpperCase())), "CONNECTION_DISCONNECTED");
    await rejectsCode(write(TENANT_A, newActive(` ${DIR_A} `)), "CONNECTION_DISCONNECTED");
    const picked = load.rules().pickConnectionFields({ ...newActive(DIR_A), tenantId: TENANT_B, connectionId: "connB", disconnectedAt: null, verified: true });
    await rejectsCode(write(TENANT_A, picked), "CONNECTION_DISCONNECTED");
  });

  test("11/12 the guard applies with ENTRA_CRM_MULTI_DIRECTORY OFF and ON", async () => {
    await disconnect();
    for (const multi of [undefined, "true"]) {
      if (multi) process.env.ENTRA_CRM_MULTI_DIRECTORY = multi;
      else delete process.env.ENTRA_CRM_MULTI_DIRECTORY;
      await rejectsCode(write(TENANT_A, newActive(DIR_A)), "CONNECTION_DISCONNECTED");
    }
    delete process.env.ENTRA_CRM_MULTI_DIRECTORY;
  });

  test("no revoked history: creating an active connection keeps the existing switch-OFF behaviour", async () => {
    await expect(write(TENANT_A, newActive("44444444-5555-6666-7777-888888888888"))).resolves.toBeUndefined();
  });

  test("6 the revoked claim is never modified by the guard", async () => {
    await disconnect();
    const revoked = clone(claims.find((c) => c.status === "revoked"));
    await write(TENANT_A, newActive(DIR_A)).catch(() => {});
    await write(TENANT_A, newActive(DIR_A, { isActive: false }));
    expect(claims.find((c) => c.status === "revoked")).toEqual(revoked);
  });
});

describe("reconnect after disconnect", () => {
  const nonceOf = (u) => new URL(u).searchParams.get("nonce");
  const stateOf = (u) => new URL(u).searchParams.get("state");
  const idToken = (nonce) =>
    signTestJwt(kp.privateKey, { iss: `https://login.microsoftonline.com/${DIR_A}/v2.0`, aud: CLIENT_ID, tid: DIR_A, oid: ADMIN_OID, nonce, wids: [GLOBAL_ADMIN] });

  test("P Connect can start again; completing creates a NEW verified claim; the revoked claim stays byte-identical", async () => {
    await disconnect();
    const revokedBefore = clone(claims.find((c) => c.connectionId === "connA" && c.status === "revoked"));
    const disconnectedAt = connA().disconnectedAt;
    const { authorizationUrl } = await load.handler().startConnect({ tenantId: TENANT_A, connectionId: "connA", userId: ADMIN_USER });
    jest.spyOn(AzureADHandler, "exchangeCodeForTokens").mockImplementation(async () => ({ id_token: await idToken(nonceOf(authorizationUrl)) }));
    const out = await load.handler().completeConnect({ tenantId: TENANT_A, connectionId: "connA", userId: ADMIN_USER, code: "c", state: stateOf(authorizationUrl) });
    expect(out).toMatchObject({ status: "connected", directoryId: DIR_A });
    const forConn = claims.filter((c) => c.connectionId === "connA");
    expect(forConn).toHaveLength(2);
    const fresh = forConn.find((c) => c.status === "verified");
    expect(fresh._id).not.toBe(revokedBefore._id);
    expect(fresh).toMatchObject({ method: "entra-admin-sign-in", verifiedBy: `user:${ADMIN_USER}`, revokedAt: null, revokedBy: null });
    expect(forConn.find((c) => c.status === "revoked")).toEqual(revokedBefore);
    // connection: connected again, still inactive, disconnect history kept
    expect(connA()).toMatchObject({ isActive: false, connectedBy: ADMIN_USER, disconnectedAt, disconnectedBy: ADMIN_USER });
    await expect(load.handler().getConnectionStatus({ tenantId: TENANT_A, connectionId: "connA" })).resolves.toMatchObject({ status: "connected" });
    // reconnected but still inactive: Test Connection allowed again (5c-2), activation allowed again
    axios.get.mockResolvedValue({
      status: 200,
      data: {
        issuer: `https://login.microsoftonline.com/${DIR_A}/v2.0`,
        authorization_endpoint: `https://login.microsoftonline.com/${DIR_A}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${DIR_A}/oauth2/v2.0/token`,
        jwks_uri: `https://login.microsoftonline.com/${DIR_A}/discovery/v2.0/keys`,
      },
    });
    axios.post.mockResolvedValue({ status: 200, data: { access_token: "x" } });
    await expect(load.handler().testConnection({ tenantId: TENANT_A, connectionId: "connA" })).resolves.toMatchObject({ ok: true, code: "CONNECTED" });
    const rules = load.rules();
    await expect(
      rules.assertConnectionWritable(TENANT_A, { ...rules.pickConnectionFields(connA()), autoProvisionUsers: false, defaultRoleId: undefined, isActive: true }, { connectionId: "connA", stored: connA() })
    ).resolves.toBeUndefined();
  });

  test("another organisation may connect the released directory (no DIRECTORY_ALREADY_CLAIMED from revoked history)", async () => {
    await disconnect();
    mockTenants[1].authenticationConnections[0].directoryId = DIR_A;
    claims.splice(claims.findIndex((c) => c.connectionId === "connB"), 1);
    await expect(load.service().assertDirectoryConnectable({ tenantId: TENANT_B, connectionId: "connB", directoryId: DIR_A })).resolves.toBe(DIR_A);
  });
});

describe("N sign-in after disconnect fails closed", () => {
  test("the resolved configuration of an inactive connection is refused (CONNECTION_INACTIVE) before any redirect", async () => {
    await disconnect();
    let code = null;
    try {
      load.resolver().resolveConnectionAuthConfig(connA());
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("CONNECTION_INACTIVE");
  });
});
