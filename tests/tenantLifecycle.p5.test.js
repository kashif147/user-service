/**
 * P5 / D6 - tenant lifecycle (delete / decommission / status) is PLATFORM-ONLY (middlewares/tenantLifecycleGuard.js).
 *
 * Same harness as platformTenantAdmin.z6.test.js: the REAL tenant router (platform registrations + tenant chains,
 * real requireTenant / requireTenantPathAccess, real platform evaluator); authenticate (x-test-* headers standing
 * in for the gateway-verified req.ctx), the policy adapter and the controllers are stubs; principal / user /
 * tenant reads are in memory. No tenant is decommissioned: the controller is a stub that only reports it was reached.
 *
 *   ASU / ordinary / legacy SU "*": own tenant -> 403 TENANT_LIFECYCLE_PLATFORM_ONLY; other tenant -> 403 (path guard)
 *   platform principal: exact platform:tenant:delete:any (delete) / platform:tenant:update:any (status) -> controller;
 *                       anything else -> 403 PLATFORM_AUTHORITY_REQUIRED (final, no fallback to tenant roles)
 *   forged headers / forged platform token -> no authority
 *   PUT /tenants/:id: a CHANGE of isActive / status, or an update operator -> 403; unchanged values -> controller
 */
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

jest.mock("../rabbitMQ", () => ({ publishDomainEvent: () => Promise.resolve(true) }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: () => false, isAssistantSuperUser: () => false, isSystemAdmin: () => false, getHighestRoleLevel: () => 1, hasMinimumRole: () => false,
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
// Stand-in PDP that PERMITS every tenant actor with a role (the real ASU path permits every own-tenant "tenant"
// action) - so a 403 below can only come from the lifecycle guard / path guard / platform guard.
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: { middleware: (resource, action) => (req, res, next) => ((req.ctx?.roles || []).length ? next() : res.status(403).json({ policy: `${resource}:${action}` })) },
}));
jest.mock("../middlewares/upload.mw", () => ({ brandingAssetUploadMw: (req, res, next) => next(), brandingAssetUpload: {}, ALLOWED_IMAGE_TYPES: [] }));
const mockReached = [];
jest.mock("../controllers/tenant.controller", () => new Proxy({}, {
  get: (_t, name) => (req, res) => {
    mockReached.push(String(name));
    res.status(200).json({ handler: `tenant.${String(name)}`, platform: req.platform || null });
  },
}));
jest.mock("../controllers/tenantBranding.controller", () => new Proxy({}, { get: () => (req, res) => res.status(200).json({}) }));

const { useTestSecret, bearer, platClaim, PID, ISSUER, OID } = require("./helpers/platformActor");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");
const Tenant = require("../models/tenant.model");

const A = "68cbf7806080b4621d469d34"; // MULTIAUTH (caller's tenant)
const B = "6acd6119b28a863c61361ae0"; // DEVTENANTB (another tenant)
const UA = "6a00000000000000000000c6";
const READ = "platform:tenant:read:any";
const UPDATE = "platform:tenant:update:any";
const DELETE = "platform:tenant:delete:any";
const CONN = "platform:tenant:auth-connections:manage:any";
const LIFECYCLE = { error: { message: "Tenant lifecycle changes are platform-only", code: "TENANT_LIFECYCLE_PLATFORM_ONLY", status: 403 } };
const PLATFORM_DENIED = { error: { message: "Platform authority required", code: "PLATFORM_AUTHORITY_REQUIRED", status: 403 } };

let server, base, principal, stored, warn;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", require("../routes/tenant.routes"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  useTestSecret();
  process.env.PLATFORM_AUTH_MODE = "shadow";
  mockReached.length = 0;
  principal = { status: "active", revision: 2, permissions: [] };
  stored = { [A]: { status: "ACTIVE", isActive: true }, [B]: { status: "ACTIVE", isActive: true } };
  jest.spyOn(PlatformPrincipal, "findById").mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === PID ? { _id: PID, issuer: ISSUER, oid: OID, ...principal } : null) }),
  }));
  jest.spyOn(User, "findOne").mockImplementation((q) => ({
    select: () => ({ lean: async () => (String(q?._id) === UA && String(q?.tenantId) === A ? { _id: UA, tenantId: A, userType: "CRM", userMicrosoftId: OID, userIssuer: ISSUER, isActive: true } : null) }),
  }));
  jest.spyOn(Tenant, "findOne").mockImplementation((q) => ({
    select: () => ({ lean: async () => (stored[String(q?._id)] ? { _id: String(q._id), ...stored[String(q._id)] } : null) }),
  }));
  warn = [];
  jest.spyOn(console, "warn").mockImplementation((...a) => warn.push(a.join(" ")));
  for (const m of ["log", "info", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.PLATFORM_AUTH_MODE;
  delete process.env.JWT_SECRET;
});

function request(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const payload = method === "GET" ? null : JSON.stringify(body || {});
    const req = http.request(`${base}${url}`, { method, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, body: json }); });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const asTenant = (roles, perms, tenant = A, user = "6a00000000000000000000a1", extra = {}) => ({
  "x-test-tenant": tenant, "x-test-user": user, "x-test-roles": JSON.stringify(roles), "x-test-perms": JSON.stringify(perms),
  authorization: bearer({ userId: user, tenantId: tenant, roles, permissions: perms }),
  ...extra,
});
const asPrincipal = (extra = {}) => ({
  "x-test-tenant": A, "x-test-user": UA, "x-test-roles": '["MO"]', "x-test-perms": "[]",
  authorization: bearer({ userId: UA, tenantId: A, roles: ["MO"], permissions: [], plat: platClaim(2) }),
  ...extra,
});

const ROUTES = [
  ["DELETE", "", DELETE, "deleteTenant", undefined],
  ["PUT", "/status", UPDATE, "updateTenantStatus", { status: "INACTIVE" }],
];
const ACTORS = [
  ["ASU", ["ASU"], ["tenant:admin", "tenant:delete", "tenant:update"]],
  ["ordinary (REO holding TENANT_DELETE / TENANT_WRITE)", ["REO"], ["tenant:delete", "tenant:write", "tenant:read"]],
  ['legacy SU "*"', ["SU"], ["*"]],
  ["tenant wildcard", ["MO"], ["tenant:*", "*:*"]],
];

describe.each(ROUTES)("%s /tenants/:id%s", (method, suffix, platformCode, handler, body) => {
  test.each(ACTORS)("%s: own tenant -> 403 TENANT_LIFECYCLE_PLATFORM_ONLY, controller never reached", async (_n, roles, perms) => {
    const r = await request(method, `/api/tenants/${A}${suffix}`, asTenant(roles, perms), body);
    expect([r.status, r.body]).toEqual([403, LIFECYCLE]);
    expect(mockReached).toEqual([]);
    expect(warn.some((l) => l.includes("tenant.lifecycle.refused"))).toBe(true);
  });

  test.each(ACTORS)("%s: another tenant -> 403 (tenant scope), controller never reached", async (_n, roles, perms) => {
    const r = await request(method, `/api/tenants/${B}${suffix}`, asTenant(roles, perms), body);
    expect(r.status).toBe(403);
    expect(r.body.error.tenantScopeViolation).toBe(true);
    expect(mockReached).toEqual([]);
  });

  test("platform principal WITHOUT the exact permission -> 403 PLATFORM_AUTHORITY_REQUIRED (no fallback to tenant roles)", async () => {
    for (const held of [[], [READ], [CONN], [READ, CONN, "platform:tenant:create"], [platformCode === DELETE ? UPDATE : DELETE]]) {
      principal.permissions = held;
      const r = await request(method, `/api/tenants/${B}${suffix}`, asPrincipal(), body);
      expect({ held, status: r.status, body: r.body }).toEqual({ held, status: 403, body: PLATFORM_DENIED });
    }
    expect(mockReached).toEqual([]);
  });

  test("platform principal disabled / stale revision -> 403", async () => {
    principal.permissions = [platformCode];
    principal.status = "disabled";
    expect((await request(method, `/api/tenants/${B}${suffix}`, asPrincipal(), body)).status).toBe(403);
    principal.status = "active";
    principal.revision = 3; // token carries rev 2
    expect((await request(method, `/api/tenants/${B}${suffix}`, asPrincipal(), body)).status).toBe(403);
    expect(mockReached).toEqual([]);
  });

  test("platform principal WITH the exact approved permission -> reaches the controller (stubbed: nothing decommissioned)", async () => {
    principal.permissions = [platformCode];
    for (const target of [B, A]) {
      mockReached.length = 0;
      const r = await request(method, `/api/tenants/${target}${suffix}`, asPrincipal(), body);
      expect([r.status, r.body.handler, r.body.platform.permission, r.body.platform.targetTenantId]).toEqual([200, `tenant.${handler}`, platformCode, target]);
      expect(mockReached).toEqual([handler]);
    }
  });

  test("forged headers / forged platform token -> no authority", async () => {
    const forged = { "x-user-roles": "ASU,SU", "x-user-permissions": `*,${platformCode}`, "x-platform-permissions": platformCode, "x-plat": JSON.stringify(platClaim(2)), "x-target-tenant-id": A, "x-jwt-verified": "true", "x-auth-source": "gateway", "x-internal-request": "true" };
    // ordinary user with forged headers, own tenant
    let r = await request(method, `/api/tenants/${A}${suffix}`, asTenant(["REO"], ["tenant:read"], A, undefined, forged), { ...(body || {}), tenantId: A, permissions: ["*"] });
    expect([r.status, r.body]).toEqual([403, LIFECYCLE]);
    // a platform-looking token signed with another secret -> not a platform actor -> tenant chain -> refused
    principal.permissions = [platformCode];
    const fake = `Bearer ${jwt.sign({ id: UA, sub: UA, tenantId: A, userType: "CRM", roles: [{ code: "ASU" }], permissions: ["*"], plat: platClaim(2) }, "not-the-secret", { algorithm: "HS256", expiresIn: "5m" })}`;
    r = await request(method, `/api/tenants/${A}${suffix}`, { ...asTenant(["ASU"], ["*"]), authorization: fake, ...forged }, body);
    expect([r.status, r.body]).toEqual([403, LIFECYCLE]);
    // no token at all, forged headers only -> no trusted tenant -> fails closed before anything else
    r = await request(method, `/api/tenants/${A}${suffix}`, forged, body);
    expect([400, 401, 403]).toContain(r.status);
    expect(mockReached).toEqual([]);
  });
});

describe("PUT /tenants/:id - lifecycle fields", () => {
  const asu = () => asTenant(["ASU"], ["tenant:admin"]);
  test.each([
    ["isActive false", { isActive: false }],
    ["status INACTIVE", { status: "INACTIVE" }],
    ["status SUSPENDED", { status: "SUSPENDED" }],
    ["status PENDING", { status: "PENDING" }],
    ["isActive as string", { isActive: "true" }],
    ["$set operator", { $set: { isActive: false } }],
    ["$unset operator", { $unset: { status: 1 } }],
    ["lifecycle change mixed into a profile update", { organisationProfile: { legalName: "x" }, isActive: false }],
  ])("ASU own tenant, %s -> 403, controller never reached", async (_n, body) => {
    const r = await request("PUT", `/api/tenants/${A}`, asu(), body);
    expect([r.status, r.body]).toEqual([403, LIFECYCLE]);
    expect(mockReached).toEqual([]);
  });

  test.each([
    ["profile only", { organisationProfile: { legalName: "x" } }],
    ["unchanged isActive / status (the CRM tenant form sends them)", { name: "x", isActive: true, status: "ACTIVE" }],
  ])("ASU own tenant, %s -> reaches the controller", async (_n, body) => {
    const r = await request("PUT", `/api/tenants/${A}`, asu(), body);
    expect([r.status, r.body.handler]).toEqual([200, "tenant.updateTenant"]);
  });

  test("stored legacy tenant without status/isActive: defaults are compared (PENDING / true)", async () => {
    stored[A] = {};
    expect((await request("PUT", `/api/tenants/${A}`, asu(), { status: "PENDING", isActive: true })).status).toBe(200);
    expect((await request("PUT", `/api/tenants/${A}`, asu(), { status: "ACTIVE" })).status).toBe(403);
  });

  test("tenant lookup error -> fail closed (403)", async () => {
    Tenant.findOne.mockImplementation(() => ({ select: () => ({ lean: async () => { throw new Error("db down"); } }) }));
    const r = await request("PUT", `/api/tenants/${A}`, asu(), { isActive: true });
    expect([r.status, r.body]).toEqual([403, LIFECYCLE]);
  });

  test("platform principal with update:any keeps full update incl. lifecycle fields (never reaches the tenant guard)", async () => {
    principal.permissions = [UPDATE];
    const r = await request("PUT", `/api/tenants/${B}`, asPrincipal(), { isActive: false, status: "INACTIVE" });
    expect([r.status, r.body.handler]).toEqual([200, "tenant.updateTenant"]);
  });
});

test("route table: the tenant-chain DELETE /tenants/:id and PUT /tenants/:id/status end in the lifecycle refusal (no controller)", () => {
  const router = require("../routes/tenant.routes");
  const chain = (method, path) => router.stack.filter((l) => l.route && l.route.path === path && l.route.methods[method]).map((l) => l.route.stack.map((s) => s.name));
  for (const [method, path] of [["delete", "/tenants/:id"], ["put", "/tenants/:id/status"]]) {
    const [platformChain, tenantChain] = chain(method, path);
    expect(platformChain[0]).toBe("platformTenantAdminGuard");
    expect(tenantChain[tenantChain.length - 1]).toBe("refuseTenantLifecycle");
  }
  const [, put] = chain("put", "/tenants/:id");
  expect(put).toContain("refuseTenantLifecycleFields");
  expect(put.indexOf("refuseTenantLifecycleFields")).toBeLessThan(put.length - 2); // before policy + controller
});
