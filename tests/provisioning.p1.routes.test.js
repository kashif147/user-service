/**
 * Phase B / P1 - the provisioning control-plane API: authority, target-tenant rules and audit.
 *
 * Mounts the REAL routes/provisioning.routes.js with the REAL requirePlatformPermission evaluator and the REAL
 * controller + run service. authenticate is a stub (identity from x-test-* headers, standing in for the
 * gateway-verified req.ctx); PlatformPrincipal / User / Tenant / PlatformTemplate / ProvisioningRun reads and
 * writes are in memory. Harness as tests/platformRoutes.z5.test.js.
 */
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

const mockPublished = [];
jest.mock("../rabbitMQ", () => ({ publishDomainEvent: (...a) => (mockPublished.push(a), Promise.resolve(true)) }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    authenticate: (req, res, next) => {
      const t = req.headers["x-test-tenant"];
      if (t) req.ctx = { tenantId: t, userId: req.headers["x-test-user"], roles: JSON.parse(req.headers["x-test-roles"] || "[]"), permissions: JSON.parse(req.headers["x-test-perms"] || "[]") };
      next();
    },
    tenantContextWarn: (req, res, next) => next(),
  };
});

const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");
const Tenant = require("../models/tenant.model");
const PlatformTemplate = require("../models/platformTemplate.model");
const ProvisioningRun = require("../models/provisioningRun.model");
const runService = require("../services/provisioningRunService");
const { DEFINITIONS, templateContentHash } = require("../constants/platformTemplates");
const { PLATFORM_PERMISSIONS } = require("../constants/platformPermissions");

const SECRET = "unit-test-only-secret-p1-routes";
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const ISSUER = `https://login.microsoftonline.com/${DIR}/v2.0`;
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const PID = "6a0000000000000000000a03";
const A = "68cbf7806080b4621d469d34"; // caller's sign-in tenant
const TARGET = "6a00000000000000000000f1"; // the tenant being provisioned (a different tenant)
const USER = "6a00000000000000000000c1";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const PROVISIONING = "platform:provisioning:admin";
const DEF = DEFINITIONS[0];
const PUBLISHED = { ...DEF, components: DEF.components.map((c) => ({ ...c })), contentHash: templateContentHash(DEF), status: "published", publishedAt: new Date(0) };

let principalState;
let server;
let base;
let logs;
const ROUTES = [
  ["GET", "/api/platform/provisioning/components"],
  ["GET", "/api/platform/provisioning/templates"],
  ["GET", `/api/platform/provisioning/templates/${DEF.key}/${DEF.version}`],
  ["POST", `/api/platform/provisioning/tenants/${TARGET}/runs`, { templateKey: DEF.key, templateVersion: DEF.version }],
  ["GET", "/api/platform/provisioning/runs"],
  ["GET", `/api/platform/provisioning/runs/${RUN_ID}`],
  ["POST", `/api/platform/provisioning/runs/${RUN_ID}/resume`, {}],
];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/provisioning.routes"));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code, status: err.status } }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const storedRun = (over = {}) => ({
  runId: RUN_ID, tenantId: TARGET, templateKey: DEF.key, templateVersion: DEF.version, templateContentHash: PUBLISHED.contentHash,
  status: "pending", attempt: 1, failureCode: null, failedStep: null, stepKeyVersion: 2, steps: runService.planSteps(RUN_ID, PUBLISHED), history: [], ...over,
});

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.PLATFORM_AUTH_MODE = "shadow"; // the DEV global mode; these routes enforce regardless
  delete process.env.GLOBAL_DATA_WRITES; // A14 frozen (DEV state)
  mockPublished.length = 0;
  logs = [];
  principalState = { status: "active", revision: 2, permissions: [PROVISIONING] };
  jest.spyOn(PlatformPrincipal, "findById").mockImplementation(() => ({ select: () => ({ lean: async () => (principalState ? { _id: PID, issuer: ISSUER, oid: OID, ...principalState } : null) }) }));
  jest.spyOn(User, "findOne").mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: USER, tenantId: A, userType: "CRM", userMicrosoftId: OID, userIssuer: ISSUER, isActive: true }) }) }));
  jest.spyOn(Tenant, "findById").mockImplementation((id) => ({ select: () => ({ lean: async () => (id === TARGET ? { _id: TARGET } : null) }) }));
  jest.spyOn(Tenant, "findOne").mockImplementation(() => { throw new Error("tenant lookup by anything but _id"); });
  jest.spyOn(PlatformTemplate, "findOne").mockImplementation(() => ({ lean: async () => PUBLISHED }));
  jest.spyOn(PlatformTemplate, "find").mockImplementation(() => ({ sort: () => ({ lean: async () => [PUBLISHED] }) }));
  jest.spyOn(ProvisioningRun, "findOneAndUpdate").mockImplementation(async (filter, update) => ({ value: { ...filter, ...update.$setOnInsert }, lastErrorObject: { updatedExisting: false } })); // upsert: filter fields + $setOnInsert
  jest.spyOn(ProvisioningRun, "findOne").mockImplementation(() => ({ lean: async () => storedRun({ status: "failed", failureCode: "TIMEOUT" }) }));
  jest.spyOn(ProvisioningRun, "find").mockImplementation(() => ({ sort: () => ({ limit: () => ({ lean: async () => [storedRun()] }) }) }));
  jest.spyOn(ProvisioningRun, "updateOne").mockImplementation(async () => ({ modifiedCount: 1 }));
  jest.spyOn(console, "info").mockImplementation((...a) => logs.push(a.join(" ")));
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.PLATFORM_AUTH_MODE;
  delete process.env.JWT_SECRET;
});

function request(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const sign = (claims) => jwt.sign({ id: USER, sub: USER, tenantId: A, userType: "CRM", ...claims }, SECRET, { algorithm: "HS256", expiresIn: "10m" });
const ident = (roles, perms, claims) => ({ "x-test-tenant": A, "x-test-user": USER, "x-test-roles": JSON.stringify(roles), "x-test-perms": JSON.stringify(perms), authorization: `Bearer ${sign(claims)}` });
const PRINCIPAL = () => ident(["MO"], [], { roles: [{ code: "MO" }], plat: { v: 1, pid: PID, rev: 2 } });
const TENANT_ACTORS = [
  ["ASU (highest tenant role)", () => ident(["ASU"], ["tenant:admin", "tenant:read"], { roles: [{ code: "ASU" }] })],
  ["legacy SU with '*'", () => ident(["SU"], ["*"], { roles: [{ code: "SU" }], permissions: ["*"] })],
  ["ordinary tenant user (MO)", () => ident(["MO"], ["tenant:read"], { roles: [{ code: "MO" }] })],
  ["no roles", () => ident([], [], {})],
];
const runPath = (target) => `/api/platform/provisioning/tenants/${encodeURIComponent(target)}/runs`;
const createRun = (headers, target, body = { templateKey: DEF.key, templateVersion: DEF.version }) => request("POST", runPath(target), headers, body);
const runEvents = () => mockPublished.filter((p) => p[0] === "platform.provisioning.run.changed.v1");

test("the surface: 7 routes, every one guarded by exactly platform:provisioning:admin (route-enforce)", () => {
  const router = require("../routes/provisioning.routes");
  const layers = router.stack.filter((l) => l.route);
  expect(layers).toHaveLength(7);
  for (const l of layers) expect(l.route.stack[0].name).toBe("platformAuthzGuard");
});

test("a live principal holding the EXACT permission passes every route", async () => {
  for (const [m, p, body] of ROUTES) {
    const res = await request(m, p, PRINCIPAL(), body);
    expect({ route: `${m} ${p}`, ok: res.status < 300 }).toEqual({ route: `${m} ${p}`, ok: true });
  }
});

test.each(TENANT_ACTORS)("%s is denied every provisioning route (403); no run is read or written", async (_n, h) => {
  for (const [m, p, body] of ROUTES) {
    const res = await request(m, p, h(), body);
    expect({ route: `${m} ${p}`, status: res.status }).toEqual({ route: `${m} ${p}`, status: 403 });
    expect(res.body).toMatch(/PLATFORM_AUTHORITY_REQUIRED/);
  }
  expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
  expect(ProvisioningRun.updateOne).not.toHaveBeenCalled();
});

test("ASU cannot provision another tenant, nor its own", async () => {
  const asu = TENANT_ACTORS[0][1];
  for (const tenantId of [TARGET, A]) {
    const res = await createRun(asu(), tenantId);
    expect(res.status).toBe(403);
  }
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test("every OTHER platform permission (all held at once) is denied: one permission never implies another", async () => {
  principalState.permissions = PLATFORM_PERMISSIONS.filter((p) => p !== PROVISIONING);
  for (const [m, p, body] of ROUTES) expect((await request(m, p, PRINCIPAL(), body)).status).toBe(403);
});

test.each([
  ["missing principal", () => { principalState = null; }],
  ["disabled principal", () => { principalState.status = "disabled"; }],
  ["revoked permission (rev bumped)", () => { principalState.revision = 3; principalState.permissions = []; }],
  ["stale token revision", () => { principalState.revision = 3; }],
])("%s -> denied", async (_n, change) => {
  change();
  expect((await createRun(PRINCIPAL(), TARGET)).status).toBe(403);
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test("platform authorization switched off -> denied (route-enforce never falls back to tenant roles)", async () => {
  process.env.PLATFORM_AUTH_MODE = "off";
  expect((await createRun(PRINCIPAL(), TARGET)).status).toBe(403);
});

test("the A14 freeze does not block the control plane, and stays frozen (GLOBAL_DATA_WRITES unset)", async () => {
  expect(process.env.GLOBAL_DATA_WRITES).toBeUndefined();
  expect((await createRun(PRINCIPAL(), TARGET)).status).toBe(201);
});

test("POST /runs creates the run for the explicit internal tenant id: steps planned, nothing dispatched", async () => {
  const res = await createRun(PRINCIPAL(), TARGET);
  expect(res.status).toBe(201);
  const { created, run } = res.json().data;
  expect(created).toBe(true);
  expect(run.tenantId).toBe(TARGET);
  expect(run.status).toBe("pending");
  expect(run.steps.map((s) => s.status)).toEqual(Array(DEF.components.length).fill("pending"));
  expect(run.steps[0].key).toBe(`psk2:${run.runId}:${DEF.components[0].component}:ensure-defaults`); // canonical v2 key
  const [filter, update] = ProvisioningRun.findOneAndUpdate.mock.calls[0];
  expect(filter).toEqual({ tenantId: TARGET, templateKey: DEF.key, templateVersion: DEF.version });
  expect(update.$setOnInsert.createdBy).toEqual({ scope: "platform", principalId: PID, actorId: null });
  expect(update.$setOnInsert).not.toHaveProperty("tenantId"); // the owner comes from the upsert filter only
  expect(Tenant.findById).toHaveBeenCalledWith(TARGET);
  // the only publish is the platform audit record
  expect(mockPublished.map((p) => p[0]).filter((t) => !t.startsWith("platform."))).toEqual([]);
});

test("a repeat request returns the existing run (200, created false) - idempotent", async () => {
  ProvisioningRun.findOneAndUpdate.mockImplementation(async () => ({ value: storedRun({ status: "succeeded" }), lastErrorObject: { updatedExisting: true } }));
  const res = await createRun(PRINCIPAL(), TARGET);
  expect(res.status).toBe(200);
  expect(res.json().data).toMatchObject({ created: false, run: { runId: RUN_ID, status: "succeeded" } });
  expect(runEvents()[0][1].action).toBe("PROVISIONING_RUN_REQUESTED_EXISTING");
});

test.each([
  ["organisation code as target", "MULTIAUTH"],
  ["Entra tid (GUID) as target", DIR],
  ["email as target", "someone@example.org"],
  ["domain as target", "example.org"],
  ["placeholder target", "default"],
  ["uppercase hex", TARGET.toUpperCase()],
  ["25 hex", `${TARGET}0`],
])("%s -> 400 INTERNAL_TENANT_ID_REQUIRED, no tenant lookup, no run", async (_n, target) => {
  const res = await createRun(PRINCIPAL(), target);
  expect(res.status).toBe(400);
  expect(res.json().error.code).toBe("INTERNAL_TENANT_ID_REQUIRED");
  expect(Tenant.findById).not.toHaveBeenCalled();
  expect(Tenant.findOne).not.toHaveBeenCalled();
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test.each(["targetTenantId", "code", "orgCode", "organisationCode", "tid", "directoryId", "domain"])("a locator field %p in the body (valid path target) is refused before any read", async (f) => {
  const res = await createRun(PRINCIPAL(), TARGET, { ...ROUTES[3][2], [f]: "MULTIAUTH" });
  expect(res.status).toBe(400);
  expect(res.json().error.code).toBe("INTERNAL_TENANT_ID_REQUIRED");
  expect(Tenant.findById).not.toHaveBeenCalled();
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test("the caller's own tenant / an unknown or tenantId body field is never used as the target", async () => {
  for (const extra of [{ tenant: TARGET }, { tenantId: TARGET }, { tenantId: A }]) {
    const res = await createRun(PRINCIPAL(), TARGET, { ...ROUTES[3][2], ...extra });
    expect(res.status).toBe(400);
  }
  expect((await request("POST", "/api/platform/provisioning/runs", PRINCIPAL(), { tenantId: TARGET, ...ROUTES[3][2] })).status).toBe(404); // the old body-target route is gone
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test("a valid-looking internal id that is not a tenant -> 404 TENANT_NOT_FOUND, no run", async () => {
  const res = await createRun(PRINCIPAL(), "6a00000000000000000000ee");
  expect(res.status).toBe(404);
  expect(res.json().error.code).toBe("TENANT_NOT_FOUND");
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test("an unpublished template / a published record that differs from its reviewed definition is refused", async () => {
  PlatformTemplate.findOne.mockImplementation(() => ({ lean: async () => null }));
  expect((await createRun(PRINCIPAL(), TARGET)).json().error.code).toBe("TEMPLATE_NOT_PUBLISHED");
  const tampered = { ...PUBLISHED, components: PUBLISHED.components.slice(1).map((c, i) => ({ ...c, order: i + 1 })) };
  PlatformTemplate.findOne.mockImplementation(() => ({ lean: async () => tampered }));
  expect((await createRun(PRINCIPAL(), TARGET)).json().error.code).toBe("TEMPLATE_INTEGRITY");
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test("resume: only a failed run; the audit records it with the run's tenant as target", async () => {
  const res = await request("POST", `/api/platform/provisioning/runs/${RUN_ID}/resume`, PRINCIPAL(), {});
  expect(res.status).toBe(200);
  ProvisioningRun.findOne.mockImplementation(() => ({ lean: async () => storedRun({ status: "succeeded" }) }));
  const again = await request("POST", `/api/platform/provisioning/runs/${RUN_ID}/resume`, PRINCIPAL(), {});
  expect(again.status).toBe(409);
  expect(again.json().error.code).toBe("RUN_STATE_CONFLICT");
  const ev = runEvents().map((p) => p[1].action);
  expect(ev).toEqual(["PROVISIONING_RUN_RESUMED", "PROVISIONING_RUN_REFUSED"]);
});

test("audit: platform scope, target = the provisioned tenant (never the caller's tenant as owner), ids and counts only", async () => {
  await createRun(PRINCIPAL(), TARGET);
  await createRun(PRINCIPAL(), "MULTIAUTH");
  const [created, refused] = runEvents();
  expect(created[2].auditContext).toEqual({ actorScope: "platform", actorTenantId: null, targetTenantId: TARGET, loginTenantId: A });
  expect(created[2].tenantId).toBeUndefined(); // no envelope owner
  expect(created[1]).toMatchObject({ principalId: PID, action: "PROVISIONING_RUN_CREATED", permission: PROVISIONING, result: "success", tenantId: TARGET, templateKey: DEF.key, templateVersion: 1, runStatus: "pending", stepCount: 7, stepsSucceeded: 0, insertedCount: 0, skippedCount: 0 });
  expect(refused[1]).toMatchObject({ action: "PROVISIONING_RUN_REFUSED", result: "failure", reason: "internal_tenant_id_required" });
  expect(refused[2].auditContext.targetTenantId).toBeNull();
  const text = JSON.stringify(runEvents());
  expect(text).not.toMatch(/eyJ|Bearer|@|oid|issuer/i);
  // enforced allow/deny decisions keep their own authz audit event
  expect(mockPublished.some((p) => p[0] === "platform.authz.decision.v1")).toBe(true);
});

test("a refusal never records an unverified tenant as the audit target", async () => {
  // format-valid but nonexistent tenant, and a bad template version (refused before the tenant lookup)
  await createRun(PRINCIPAL(), "6a00000000000000000000ee");
  await createRun(PRINCIPAL(), "6a00000000000000000000ee", { templateKey: DEF.key, templateVersion: "1" });
  // an existing tenant with an unpublished template: verified, so it is the target
  PlatformTemplate.findOne.mockImplementation(() => ({ lean: async () => null }));
  await createRun(PRINCIPAL(), TARGET);
  const [notFound, badVersion, unpublished] = runEvents();
  expect([notFound[1].reason, notFound[2].auditContext.targetTenantId, notFound[1].tenantId]).toEqual(["tenant_not_found", null, undefined]);
  expect([badVersion[1].reason, badVersion[2].auditContext.targetTenantId]).toEqual(["bad_request", null]);
  expect([unpublished[1].reason, unpublished[2].auditContext.targetTenantId]).toEqual(["template_not_published", TARGET]);
});
