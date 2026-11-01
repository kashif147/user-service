/**
 * Phase B / Z5 - platform audit producers + the D4 internal platform-auth check.
 *
 *  - Successful platform tenant creation: authoritative platform.tenant.created.v1 (no envelope tenant,
 *    target = the NEW tenant, pid, exact permission) + tenant.lifecycle.created.v1 (envelope = the new tenant,
 *    platform / null / new, no pid / operator / sign-in tenant). Same correlation id. Denied / failed creation:
 *    platform record only.
 *  - Principal-admin script: every executed mutation (and a failed one) -> platform.principal.changed.v1,
 *    system actor platform:principal-admin, operator label + approval as supplied metadata; awaited.
 *  - POST /internal/platform-auth/check: trusted secret only, actor from the verified token only, exact
 *    permission, minimum response, fail closed.
 */
process.env.PLATFORM_AUTH_MODE = "shadow";
const mockPublished = [];
const mockRabbit = { fn: async () => true, inits: 0 };
jest.mock("../rabbitMQ", () => ({
  publishDomainEvent: (...a) => (mockPublished.push(a), mockRabbit.fn(...a)),
  initEventSystem: async () => { mockRabbit.inits += 1; },
}));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: () => false, isAssistantSuperUser: () => false, isSystemAdmin: () => false, getHighestRoleLevel: () => 1, hasMinimumRole: () => false,
}));
jest.mock("../handlers/tenant.handler", () => ({ createTenant: jest.fn() }));

const http = require("http");
const express = require("express");
const TenantHandler = require("../handlers/tenant.handler");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const { createTenant } = require("../controllers/tenant.controller");
const { EVENTS, PRINCIPAL_ADMIN_ACTOR } = require("../services/platformAuditService");
const { runCommand } = require("../scripts/platform-principal");
const { useTestSecret, bearer, platClaim, installPrincipal, PID, OID, ISSUER } = require("./helpers/platformActor");

const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const NEW = "6b0000000000000000000e01";
const USER = "6a00000000000000000000c5";
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockPublished.length = 0;
  mockRabbit.fn = async () => true;
  useTestSecret();
  for (const m of ["info", "warn", "log", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const platformReq = () => {
  const req = { method: "POST", baseUrl: "/api", route: { path: "/tenants" }, headers: { "x-correlation-id": "corr-create-1" }, ctx: { userId: USER, tenantId: A }, body: { code: "Z5TMP", name: "Z5 temp" } };
  Object.defineProperty(req, "platform", { value: Object.freeze({ pid: PID, permission: "platform:tenant:create" }), enumerable: false });
  return req;
};
const mkRes = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

describe("tenant creation audit (owner decision: two records on success, platform-only on failure)", () => {
  test("success -> authoritative platform record (target = new tenant) + the new tenant's lifecycle copy, one correlation id", async () => {
    TenantHandler.createTenant.mockResolvedValue({ _id: NEW, code: "Z5TMP", name: "Z5 temp" });
    const res = mkRes();
    await createTenant(platformReq(), res, jest.fn());
    await flush();
    expect(res.statusCode).toBe(201);
    expect(mockPublished.map((p) => p[0])).toEqual([EVENTS.PLATFORM_TENANT_CREATED, EVENTS.TENANT_LIFECYCLE_CREATED]);
    const [[, pData, pMeta], [, cData, cMeta]] = mockPublished;
    expect(pData).toEqual({ principalId: PID, actorUserId: USER, tenantId: NEW, permission: "platform:tenant:create", route: "POST /api/tenants" });
    expect(pMeta).toEqual({ correlationId: "corr-create-1", auditContext: { actorScope: "platform", actorTenantId: null, targetTenantId: NEW, loginTenantId: A } });
    expect(pMeta.tenantId).toBeUndefined(); // the platform record has no owner - never the sign-in tenant
    expect(cData).toEqual({ tenantId: NEW });
    expect(cMeta).toEqual({ tenantId: NEW, correlationId: "corr-create-1", auditContext: { actorScope: "platform", actorTenantId: null, targetTenantId: NEW } });
    expect(JSON.stringify(mockPublished[1])).not.toMatch(new RegExp(`${PID}|${A}|${USER}|platform:tenant:create`)); // copy: no platform detail
  });

  test.each([
    [new Error("Error creating tenant: Tenant code or domain already exists"), "conflict"],
    [new Error("Error creating tenant: boom"), "error"],
  ])("failure -> platform record only (no tenant exists: target null), never a tenant copy", async (err, reason) => {
    TenantHandler.createTenant.mockRejectedValue(err);
    const next = jest.fn();
    await createTenant(platformReq(), mkRes(), next);
    await flush();
    expect(next).toHaveBeenCalled();
    expect(mockPublished.map((p) => p[0])).toEqual([EVENTS.PLATFORM_TENANT_CREATE_FAILED]);
    expect(mockPublished[0][1]).toMatchObject({ principalId: PID, permission: "platform:tenant:create", reason });
    expect(mockPublished[0][2].auditContext).toEqual({ actorScope: "platform", actorTenantId: null, targetTenantId: null, loginTenantId: A });
    expect(mockPublished[0][2].tenantId).toBeUndefined();
  });

  test("without a platform actor (req.platform) nothing is published - the route guard is the only way in", async () => {
    TenantHandler.createTenant.mockResolvedValue({ _id: NEW });
    const req = platformReq();
    const plain = { ...req }; // spread drops the non-enumerable req.platform
    await createTenant(plain, mkRes(), jest.fn());
    await flush();
    expect(mockPublished).toHaveLength(0);
  });

  test("a publish failure never changes the create response", async () => {
    mockRabbit.fn = async () => { throw new Error("broker down"); };
    TenantHandler.createTenant.mockResolvedValue({ _id: NEW });
    const res = mkRes();
    await createTenant(platformReq(), res, jest.fn());
    await flush();
    expect(res.statusCode).toBe(201);
  });
});

describe("principal-admin script audit (system actor platform:principal-admin)", () => {
  const ops = { by: "claude-z5-dev", approval: "owner-Z5-brief-2026-10-29", execute: true };
  const current = { _id: PID, issuer: ISSUER, oid: OID, tid: "39866a06-30bc-4a89-80c6-9dd9357dd453", status: "active", revision: 3, permissions: ["platform:tenant:create"], changes: [] };
  const lean = (v) => ({ lean: async () => v });

  test("set-permissions -> success event with added / removed codes, operator label + approval as supplied metadata", async () => {
    jest.spyOn(PlatformPrincipal, "findById").mockReturnValue(lean(current));
    jest.spyOn(PlatformPrincipal, "findOneAndUpdate").mockReturnValue(lean({ ...current, revision: 4, permissions: ["platform:cache:admin"] }));
    await runCommand({ ...ops, command: "set-permissions", id: PID, permissions: "platform:cache:admin" });
    expect(mockRabbit.inits).toBeGreaterThan(0);
    expect(mockPublished).toHaveLength(1);
    const [type, data, meta] = mockPublished[0];
    expect(type).toBe(EVENTS.PLATFORM_PRINCIPAL_CHANGED);
    expect(data).toEqual({
      actorId: PRINCIPAL_ADMIN_ACTOR, action: "set-permissions", result: "success", principalId: PID, status: "active", revision: 4,
      permissionsAdded: ["platform:cache:admin"], permissionsRemoved: ["platform:tenant:create"], operatorLabel: ops.by, approvalRef: ops.approval,
    });
    expect(meta.auditContext).toEqual({ actorScope: "system", actorTenantId: null, targetTenantId: null });
    expect(meta.tenantId).toBeUndefined();
    expect(JSON.stringify(mockPublished)).not.toMatch(new RegExp(`${OID}|login.microsoftonline`));
  });

  test.each(["disable", "enable"])("%s -> success event with the new status / revision", async (command) => {
    jest.spyOn(PlatformPrincipal, "findById").mockReturnValue(lean(current));
    jest.spyOn(PlatformPrincipal, "findOneAndUpdate").mockReturnValue(lean({ ...current, revision: 4, status: command === "disable" ? "disabled" : "active" }));
    await runCommand({ ...ops, command, id: PID });
    expect(mockPublished[0][1]).toMatchObject({ action: command, result: "success", status: command === "disable" ? "disabled" : "active", revision: 4, permissionsAdded: [], permissionsRemoved: [] });
  });

  test("create -> success event for the new principal (no oid / issuer in the event)", async () => {
    jest.spyOn(PlatformPrincipal.prototype, "validate").mockResolvedValue();
    jest.spyOn(PlatformPrincipal, "create").mockResolvedValue({ _id: PID, status: "active", revision: 1, permissions: ["platform:tenant:create"], toObject() { return { ...current, revision: 1 }; } });
    await runCommand({ ...ops, command: "create", issuer: ISSUER, oid: OID, permissions: "platform:tenant:create" });
    expect(mockPublished[0][1]).toMatchObject({ action: "create", result: "success", principalId: PID, revision: 1, permissionsAdded: ["platform:tenant:create"] });
    expect(JSON.stringify(mockPublished)).not.toContain(OID);
  });

  test("a failed write (concurrent change) -> failure event, then the error", async () => {
    jest.spyOn(PlatformPrincipal, "findById").mockReturnValue(lean(current));
    jest.spyOn(PlatformPrincipal, "findOneAndUpdate").mockReturnValue(lean(null));
    await expect(runCommand({ ...ops, command: "disable", id: PID })).rejects.toThrow(/concurrently/);
    expect(mockPublished[0][1]).toMatchObject({ action: "disable", result: "failure", reason: "concurrent_change" });
  });

  test("dry runs and list never publish; a publish failure keeps the change but exits 2", async () => {
    jest.spyOn(PlatformPrincipal, "findById").mockReturnValue(lean(current));
    await runCommand({ ...ops, execute: false, command: "disable", id: PID });
    expect(mockPublished).toHaveLength(0);
    mockRabbit.fn = async () => false;
    jest.spyOn(PlatformPrincipal, "findOneAndUpdate").mockReturnValue(lean({ ...current, revision: 4, status: "disabled" }));
    await runCommand({ ...ops, command: "disable", id: PID });
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });
});

describe("POST /internal/platform-auth/check (D4)", () => {
  const SECRET = "z5-unit-test-internal-check-secret-0123456789";
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/internal", require("../routes/internalPlatformAuth.routes")); // as routes/index.js mounts it
    await new Promise((r) => (server = app.listen(0, r)));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => { process.env.PLATFORM_AUTH_CHECK_SECRET = SECRET; });
  afterEach(() => { delete process.env.PLATFORM_AUTH_CHECK_SECRET; });

  const post = (path, { body = { permission: "platform:cache:admin" }, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    rq.on("error", reject);
    rq.write(data);
    rq.end();
  });
  const platformToken = () => bearer({ userId: USER, tenantId: A, roles: [], plat: platClaim() });
  const trusted = (extra = {}) => ({ "x-service-secret": SECRET, authorization: platformToken(), ...extra });

  test("valid caller + live principal with the exact permission -> 200 { allowed, permission, pid } and nothing else", async () => {
    installPrincipal({ permissions: ["platform:cache:admin"], userId: USER, tenantId: A });
    const r = await post("/internal/platform-auth/check", { headers: trusted() });
    expect(r).toEqual({ status: 200, body: { allowed: true, permission: "platform:cache:admin", pid: PID } });
  });

  test("the caller is never trusted without the service secret: unset, short or wrong secret -> 403 before any lookup", async () => {
    installPrincipal({ permissions: ["platform:cache:admin"], userId: USER, tenantId: A });
    for (const [secret, header] of [[undefined, SECRET], ["short-secret", "short-secret"], [SECRET, "wrong"], [SECRET, undefined]]) {
      if (secret === undefined) delete process.env.PLATFORM_AUTH_CHECK_SECRET; else process.env.PLATFORM_AUTH_CHECK_SECRET = secret;
      const h = { authorization: platformToken() };
      if (header !== undefined) h["x-service-secret"] = header;
      expect(await post("/internal/platform-auth/check", { headers: h })).toEqual({ status: 403, body: { allowed: false } });
    }
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  });

  test("mounted at /internal, outside /api (the gateway only proxies /user-service/api|auth|pkce)", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "routes", "index.js"), "utf8");
    expect(src).toMatch(/router\.use\("\/internal", require\("\.\/internalPlatformAuth\.routes"\)\)/);
    expect(src).not.toMatch(/router\.use\("\/api", require\("\.\/internalPlatformAuth\.routes"\)\)/);
  });

  test("denials are a bare { allowed: false }: wrong permission, legacy SU '*', disabled, stale revision", async () => {
    installPrincipal({ permissions: ["platform:tenant:create"], userId: USER, tenantId: A });
    expect(await post("/internal/platform-auth/check", { headers: trusted() })).toEqual({ status: 403, body: { allowed: false } });
    const su = bearer({ userId: USER, tenantId: A, roles: ["SU"], permissions: ["*"] });
    expect(await post("/internal/platform-auth/check", { headers: trusted({ authorization: su }) })).toEqual({ status: 403, body: { allowed: false } });
    jest.restoreAllMocks(); for (const m of ["info", "warn"]) jest.spyOn(console, m).mockImplementation(() => {});
    installPrincipal({ permissions: ["platform:cache:admin"], status: "disabled", userId: USER, tenantId: A });
    expect((await post("/internal/platform-auth/check", { headers: trusted() })).status).toBe(403);
    jest.restoreAllMocks(); for (const m of ["info", "warn"]) jest.spyOn(console, m).mockImplementation(() => {});
    installPrincipal({ permissions: ["platform:cache:admin"], revision: 2, userId: USER, tenantId: A });
    expect((await post("/internal/platform-auth/check", { headers: trusted() })).status).toBe(403);
  });

  test("caller forgery: identity headers that differ from the token, or identity / claim fields in the body, are refused", async () => {
    installPrincipal({ permissions: ["platform:cache:admin"], userId: USER, tenantId: A });
    expect(await post("/internal/platform-auth/check", { headers: trusted({ "x-tenant-id": B }) })).toEqual({ status: 403, body: { allowed: false } });
    expect(await post("/internal/platform-auth/check", { headers: trusted({ "x-user-id": "6a00000000000000000000ff" }) })).toEqual({ status: 403, body: { allowed: false } });
    for (const extra of [{ userId: USER }, { tenantId: A }, { pid: PID }, { plat: platClaim() }, { roles: ["SU"] }]) {
      expect((await post("/internal/platform-auth/check", { headers: trusted(), body: { permission: "platform:cache:admin", ...extra } })).status).toBe(400);
    }
    // matching hints are fine
    expect((await post("/internal/platform-auth/check", { headers: trusted({ "x-tenant-id": A, "x-user-id": USER }) })).status).toBe(200);
  });

  test("exact permission only: wildcard, prefix, tenant or unknown codes -> 400", async () => {
    for (const permission of ["*", "platform:*", "platform:cache", "admin:write", "tenant:admin", "platform:cache:admin:extra", 42]) {
      expect((await post("/internal/platform-auth/check", { headers: trusted(), body: { permission } })).status).toBe(400);
    }
  });

  test("no / invalid bearer -> 401 { allowed: false }; a lookup failure fails closed (403)", async () => {
    expect(await post("/internal/platform-auth/check", { headers: { "x-service-secret": SECRET } })).toEqual({ status: 401, body: { allowed: false } });
    expect(await post("/internal/platform-auth/check", { headers: trusted({ authorization: "Bearer not-a-jwt" }) })).toEqual({ status: 401, body: { allowed: false } });
    jest.spyOn(PlatformPrincipal, "findById").mockImplementation(() => ({ select: () => ({ lean: async () => { throw new Error("mongo down"); } }) }));
    expect(await post("/internal/platform-auth/check", { headers: trusted() })).toEqual({ status: 403, body: { allowed: false } });
  });

  test("the log line carries decision metadata only (no token, oid, issuer, email)", async () => {
    installPrincipal({ permissions: ["platform:cache:admin"], userId: USER, tenantId: A });
    const token = platformToken();
    await post("/internal/platform-auth/check", { headers: trusted({ authorization: token }) });
    const lines = console.info.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("[platform-authz-check]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(token.slice(7));
    expect(lines[0]).not.toMatch(new RegExp(`${OID}|login.microsoftonline|@`));
    expect(JSON.parse(lines[0].slice("[platform-authz-check] ".length))).toMatchObject({ allowed: true, reason: "allowed", permission: "platform:cache:admin", pid: `…${PID.slice(-6)}` });
  });
});
