/**
 * Phase B / P1 - the provisioning routes under the REAL enforce-mode tenant-context guard (policy-middleware
 * tenantContextMiddleware, as on DEV: TENANT_CONTEXT_MODE=enforce). Found in the DEV live proof: a body /
 * query / params `tenantId` that differs from the caller's trusted tenant is refused (403
 * TENANT_CONTEXT_MISMATCH) - so a platform principal (signed in to tenant A) must name the target tenant in the
 * PATH (`/tenants/:targetTenantId/runs`, `?targetTenantId=`), never in a `tenantId` key.
 * Only authenticate is stubbed (req.ctx from x-test-* headers); the gateway trust headers are set as the gateway
 * sets them. Model reads/writes are in memory.
 */
process.env.TENANT_CONTEXT_MODE = "enforce"; // read when middlewares/auth.js builds its tenant-context middleware

const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

jest.mock("../rabbitMQ", () => ({ publishDomainEvent: () => Promise.resolve(true) }));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual, // the REAL tenantContextWarn (enforce)
    authenticate: (req, res, next) => {
      req.ctx = { tenantId: req.headers["x-test-tenant"], userId: req.headers["x-test-user"], roles: [], permissions: [] };
      next();
    },
  };
});

const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");
const Tenant = require("../models/tenant.model");
const PlatformTemplate = require("../models/platformTemplate.model");
const ProvisioningRun = require("../models/provisioningRun.model");
const { DEFINITIONS, templateContentHash } = require("../constants/platformTemplates");

const SECRET = "unit-test-only-secret-p1-tenant-context";
const ISSUER = "https://login.microsoftonline.com/39866a06-30bc-4a89-80c6-9dd9357dd453/v2.0";
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const PID = "6a0000000000000000000a03";
const A = "68cbf7806080b4621d469d34"; // the principal signed in to A
const TARGET = "6a00000000000000000000f1"; // and provisions another tenant
const USER = "6a00000000000000000000c1";
const DEF = DEFINITIONS[0];
const PUBLISHED = { ...DEF, components: DEF.components.map((c) => ({ ...c })), contentHash: templateContentHash(DEF), status: "published" };

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/provisioning.routes"));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code } }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.PLATFORM_AUTH_MODE = "shadow";
  jest.spyOn(PlatformPrincipal, "findById").mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: PID, issuer: ISSUER, oid: OID, status: "active", revision: 1, permissions: ["platform:provisioning:admin"] }) }) }));
  jest.spyOn(User, "findOne").mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: USER, tenantId: A, userType: "CRM", userMicrosoftId: OID, userIssuer: ISSUER, isActive: true }) }) }));
  jest.spyOn(Tenant, "findById").mockImplementation((id) => ({ select: () => ({ lean: async () => (id === TARGET ? { _id: TARGET } : null) }) }));
  jest.spyOn(PlatformTemplate, "findOne").mockImplementation(() => ({ lean: async () => PUBLISHED }));
  jest.spyOn(ProvisioningRun, "findOneAndUpdate").mockImplementation(async (filter, update) => ({ value: { ...filter, ...update.$setOnInsert }, lastErrorObject: { updatedExisting: false } }));
  jest.spyOn(ProvisioningRun, "find").mockImplementation(() => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }));
  for (const m of ["log", "info", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.JWT_SECRET;
  delete process.env.PLATFORM_AUTH_MODE;
});

function request(method, path, body) {
  const token = jwt.sign({ id: USER, sub: USER, tenantId: A, userType: "CRM", plat: { v: 1, pid: PID, rev: 1 } }, SECRET, { algorithm: "HS256", expiresIn: "10m" });
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}`, "x-test-tenant": A, "x-test-user": USER, "x-auth-source": "gateway", "x-jwt-verified": "true", "x-tenant-id": A };
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${path}`, { method, headers: { ...headers, ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const TPL = { templateKey: DEF.key, templateVersion: DEF.version };

test("a principal signed in to A provisions tenant B through the PATH target - the guard does not interfere", async () => {
  const res = await request("POST", `/api/platform/provisioning/tenants/${TARGET}/runs`, TPL);
  expect(res.status).toBe(201);
  expect(JSON.parse(res.body).data.run.tenantId).toBe(TARGET);
  expect(ProvisioningRun.findOneAndUpdate.mock.calls[0][0].tenantId).toBe(TARGET);
});

test("a body `tenantId` naming another tenant is refused by the guard (why the target is never a tenantId key)", async () => {
  const res = await request("POST", `/api/platform/provisioning/tenants/${TARGET}/runs`, { ...TPL, tenantId: TARGET });
  expect(res.status).toBe(403);
  expect(res.body).toMatch(/TENANT_CONTEXT_MISMATCH/);
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test("a body `tenantId` equal to the caller's own tenant passes the guard but is still not a target (400)", async () => {
  const res = await request("POST", `/api/platform/provisioning/tenants/${TARGET}/runs`, { ...TPL, tenantId: A });
  expect(res.status).toBe(400);
  expect(ProvisioningRun.findOneAndUpdate).not.toHaveBeenCalled();
});

test("list filter: ?targetTenantId= works; ?tenantId= for another tenant is refused by the guard", async () => {
  expect((await request("GET", `/api/platform/provisioning/runs?targetTenantId=${TARGET}`)).status).toBe(200);
  expect(ProvisioningRun.find.mock.calls[0][0]).toEqual({ tenantId: TARGET });
  const res = await request("GET", `/api/platform/provisioning/runs?tenantId=${TARGET}`);
  expect(res.status).toBe(403);
  expect(res.body).toMatch(/TENANT_CONTEXT_MISMATCH/);
});
