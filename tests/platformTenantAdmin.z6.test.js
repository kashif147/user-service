/**
 * Phase B / Z6 - cross-tenant tenant administration by a platform principal (owner brief Z6).
 *
 * Mounts the REAL tenant router (platform registrations + unchanged tenant chains, real requireTenant /
 * requireTenantPathAccess, real platform evaluator, real platformAuditService). authenticate (identity from
 * x-test-* headers standing in for the gateway-verified req.ctx), the policy adapter and the controllers are
 * stubs; the PlatformPrincipal / User / Tenant reads are in memory; RabbitMQ publishes are captured.
 *
 *   permission map    read:any (list, by id, stats) / update:any (update, status, organisation profile, branding,
 *                     regional settings, branding asset) / delete:any (delete) / auth-connections:manage:any
 *                     (all 10 auth-connection routes, reads included). Exact: one never implies another.
 *   tenant actors     legacy SU "*", ASU, ordinary users: the unchanged tenant chain (own tenant only).
 *   principal state   stale revision / disabled / binding lost -> 403; final (no fallback to tenant roles).
 *   target            the :id route parameter only (x-target-tenant-id / body / query ignored); authority first,
 *                     then 400 (not an id) / 404 (no such tenant); req.platform.targetTenantId, req.ctx untouched.
 *   login tenant      context only: same result whichever tenant the principal signed in through.
 *   audit             every platform decision -> platform.authz.decision.v1 with the target; mutations -> outcome
 *                     platform.tenant.admin.changed.v1 + tenant copy only for approved actions.
 */
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");

jest.mock("../rabbitMQ", () => ({ publishDomainEvent: (...a) => (mockPublished.push(a), Promise.resolve(true)) }));
const mockPublished = [];
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
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: { middleware: (resource, action) => (req, res, next) => ((req.ctx?.roles || []).length ? next() : res.status(403).json({ policy: `${resource}:${action}` })) },
}));
jest.mock("../middlewares/upload.mw", () => ({ brandingAssetUploadMw: (req, res, next) => next(), brandingAssetUpload: {}, ALLOWED_IMAGE_TYPES: [] }));
function mockControllerProxy(label) {
  return new Proxy({}, {
    get: (_t, name) => (req, res) => res.status(Number(req.headers["x-test-status"]) || 200).json({
      handler: `${label}.${String(name)}`, platform: req.platform || null, ctxTenant: req.ctx?.tenantId || null,
    }),
  });
}
jest.mock("../controllers/tenant.controller", () => mockControllerProxy("tenant"));
jest.mock("../controllers/tenantBranding.controller", () => mockControllerProxy("branding"));

const { useTestSecret, bearer, platClaim, PID, ISSUER, OID } = require("./helpers/platformActor");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");
const Tenant = require("../models/tenant.model");

const A = "68cbf7806080b4621d469d34"; // MULTIAUTH (login tenant)
const B = "6acd6119b28a863c61361ae0"; // DEVTENANTB (target)
const D = "6ad4e0c941376f7df605fd57"; // DEVDIRB (second login tenant)
const MISSING = "6b00000000000000000000ff";
const UA = "6a00000000000000000000c6"; // the principal's CRM user in A
const UD = "6a00000000000000000000d6"; // the same person's CRM user in D (same Microsoft identity)
const READ = "platform:tenant:read:any";
const UPDATE = "platform:tenant:update:any";
const DELETE = "platform:tenant:delete:any";
const CONN = "platform:tenant:auth-connections:manage:any";
const C = "6b0000000000000000000c01";

// [method, path (B as :id), permission, change action | null, handler]
const Z6 = [
  ["GET", "/api/tenants", READ, null, "tenant.getAllTenants"],
  ["GET", `/api/tenants/${B}`, READ, null, "tenant.getTenantById"],
  ["GET", `/api/tenants/${B}/stats`, READ, null, "tenant.getTenantStats"],
  ["PUT", `/api/tenants/${B}`, UPDATE, "TENANT_UPDATED", "tenant.updateTenant"],
  ["PUT", `/api/tenants/${B}/status`, UPDATE, "status", "tenant.updateTenantStatus"],
  ["PATCH", `/api/tenants/${B}/organisation-profile`, UPDATE, "TENANT_UPDATED", "tenant.updateOrganisationProfile"],
  ["PATCH", `/api/tenants/${B}/branding`, UPDATE, "TENANT_UPDATED", "tenant.updateBranding"],
  ["PATCH", `/api/tenants/${B}/regional-settings`, UPDATE, "TENANT_UPDATED", "tenant.updateRegionalSettings"],
  ["POST", `/api/tenants/${B}/branding/assets`, UPDATE, "TENANT_UPDATED", "branding.uploadBrandingAsset"],
  ["DELETE", `/api/tenants/${B}`, DELETE, "TENANT_DELETED", "tenant.deleteTenant"],
  ["POST", `/api/tenants/${B}/auth-connections`, CONN, "AUTH_CONNECTION_ADDED", "tenant.addAuthenticationConnection"],
  ["GET", `/api/tenants/${B}/auth-connections`, CONN, null, "tenant.getAuthenticationConnections"],
  ["GET", `/api/tenants/${B}/auth-connections/default-role-options`, CONN, null, "tenant.getDefaultRoleOptions"],
  ["PUT", `/api/tenants/${B}/auth-connections/${C}`, CONN, "AUTH_CONNECTION_UPDATED", "tenant.updateAuthenticationConnection"],
  ["POST", `/api/tenants/${B}/auth-connections/${C}/connect`, CONN, "AUTH_CONNECTION_CONNECT_STARTED", "tenant.startEntraConnect"],
  ["POST", `/api/tenants/${B}/auth-connections/${C}/connect/complete`, CONN, "AUTH_CONNECTION_CONNECTED", "tenant.completeEntraConnect"],
  ["POST", `/api/tenants/${B}/auth-connections/${C}/test`, CONN, "AUTH_CONNECTION_TESTED", "tenant.testEntraConnection"],
  ["POST", `/api/tenants/${B}/auth-connections/${C}/disconnect`, CONN, "AUTH_CONNECTION_DISCONNECTED", "tenant.disconnectEntraConnection"],
  ["GET", `/api/tenants/${B}/auth-connections/${C}/status`, CONN, null, "tenant.getEntraConnectionStatus"],
  ["DELETE", `/api/tenants/${B}/auth-connections/${C}`, CONN, "AUTH_CONNECTION_REMOVED", "tenant.removeAuthenticationConnection"],
];
const ALL = [READ, UPDATE, DELETE, CONN];

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", require("../routes/tenant.routes"));
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

let principal;
let logs;
const TENANTS = { [A]: "ACTIVE", [B]: "ACTIVE", [D]: "ACTIVE" };
beforeEach(() => {
  useTestSecret();
  process.env.PLATFORM_AUTH_MODE = "shadow"; // DEV: global mode shadow; Z6 routes enforce for platform principals
  mockPublished.length = 0;
  logs = [];
  principal = { status: "active", revision: 2, permissions: [] };
  jest.spyOn(PlatformPrincipal, "findById").mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === PID ? { _id: PID, issuer: ISSUER, oid: OID, ...principal } : null) }),
  }));
  // Binding: the same Microsoft identity has a CRM user in A and in D.
  jest.spyOn(User, "findOne").mockImplementation((q) => ({
    select: () => ({
      lean: async () => ([[UA, A], [UD, D]].some(([u, t]) => String(q?._id) === u && String(q?.tenantId) === t)
        ? { _id: q._id, tenantId: q.tenantId, userType: "CRM", userMicrosoftId: OID, userIssuer: ISSUER, isActive: true } : null),
    }),
  }));
  jest.spyOn(Tenant, "findOne").mockImplementation((q) => ({
    select: () => ({ lean: async () => (TENANTS[String(q?._id)] ? { _id: String(q._id), status: TENANTS[String(q._id)] } : null) }),
  }));
  jest.spyOn(console, "info").mockImplementation((...a) => logs.push(a.join(" ")));
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
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
const flush = () => new Promise((r) => setTimeout(r, 20));
const asPrincipal = ({ login = A, user = UA, rev = 2, extra = {} } = {}) => ({
  "x-test-tenant": login, "x-test-user": user, "x-test-roles": '["MO"]', "x-test-perms": "[]",
  authorization: bearer({ userId: user, tenantId: login, roles: ["MO"], permissions: [], plat: platClaim(rev) }),
  ...extra,
});
const asTenant = (roles, perms, tenant = A, user = "6a00000000000000000000a1") => ({
  "x-test-tenant": tenant, "x-test-user": user, "x-test-roles": JSON.stringify(roles), "x-test-perms": JSON.stringify(perms),
  authorization: bearer({ userId: user, tenantId: tenant, roles, permissions: perms }),
});
const events = (type) => mockPublished.filter(([t]) => t === type).map(([, data, opts]) => ({ data, opts }));
const DENIED = { error: { message: "Platform authority required", code: "PLATFORM_AUTHORITY_REQUIRED", status: 403 } };

// ── permission map ──────────────────────────────────────────────────────────
test("the 20 Z6 routes: each passes ONLY with its exact platform permission; 403 with every other one", async () => {
  for (const [method, url, need, , handler] of Z6) {
    for (const held of ALL) {
      principal.permissions = [held];
      const r = await request(method, url, asPrincipal());
      if (held === need) {
        expect({ url, method, status: r.status, handler: r.body.handler }).toEqual({ url, method, status: 200, handler });
      } else {
        expect({ url, method, held, status: r.status, body: r.body }).toEqual({ url, method, held, status: 403, body: DENIED });
      }
    }
  }
});

test("read:any does not imply update / delete / auth connections; update:any does not imply delete or auth connections", async () => {
  principal.permissions = [READ];
  expect((await request("PUT", `/api/tenants/${B}`, asPrincipal())).status).toBe(403);
  expect((await request("DELETE", `/api/tenants/${B}`, asPrincipal())).status).toBe(403);
  expect((await request("GET", `/api/tenants/${B}/auth-connections`, asPrincipal())).status).toBe(403); // no connection read via read:any
  principal.permissions = [UPDATE];
  expect((await request("DELETE", `/api/tenants/${B}`, asPrincipal())).status).toBe(403);
  for (const [method, url, need] of Z6.filter((z) => z[2] === CONN)) {
    expect({ method, url, status: (await request(method, url, asPrincipal())).status, need }).toEqual({ method, url, status: 403, need });
  }
  principal.permissions = [UPDATE, READ, DELETE, "platform:tenant:create", "platform:cache:admin"];
  expect((await request("POST", `/api/tenants/${B}/auth-connections`, asPrincipal())).status).toBe(403);
  principal.permissions = ["platform:*", "*", "platform:tenant:*", "platform:tenant:auth-connections:manage"];
  expect((await request("GET", `/api/tenants/${B}/auth-connections`, asPrincipal())).status).toBe(403); // exact codes only
});

test("cross-tenant read: the principal reads its own login tenant AND other tenants with read:any; global list", async () => {
  principal.permissions = [READ];
  for (const t of [A, B, D]) {
    const r = await request("GET", `/api/tenants/${t}`, asPrincipal());
    expect([r.status, r.body.handler, r.body.platform.targetTenantId]).toEqual([200, "tenant.getTenantById", t]);
  }
  const list = await request("GET", "/api/tenants", asPrincipal());
  expect([list.status, list.body.platform]).toEqual([200, { pid: PID, permission: READ, targetTenantId: null, loginTenantId: A }]);
});

// ── principal state ──────────────────────────────────────────────────────────
test("stale revision / disabled / binding lost / no permission -> 403; final (no fallback to tenant roles)", async () => {
  principal.permissions = [READ];
  expect((await request("GET", `/api/tenants/${B}`, asPrincipal({ rev: 1 }))).body).toEqual(DENIED); // token rev 1, live rev 2
  principal.status = "disabled";
  expect((await request("GET", `/api/tenants/${B}`, asPrincipal())).body).toEqual(DENIED);
  principal = { status: "active", revision: 2, permissions: [READ] };
  expect((await request("GET", `/api/tenants/${B}`, asPrincipal({ user: "6a00000000000000000000e9" }))).body).toEqual(DENIED); // binding lost
  // Own login tenant, tenant roles present, but no update:any: the tenant chain would have allowed it - not here.
  expect((await request("PUT", `/api/tenants/${A}`, asPrincipal())).body).toEqual(DENIED);
  const reasons = logs.filter((l) => l.startsWith("[platform-authz]")).map((l) => JSON.parse(l.slice(17)).reason);
  expect(reasons).toEqual(["stale_rev", "disabled", "binding_lost", "permission_missing"]);
});

// ── tenant actors unchanged ──────────────────────────────────────────────────
test("legacy SU '*' / ASU / ordinary users: unchanged tenant chain - own tenant only, never req.platform, no platform audit", async () => {
  for (const [roles, perms] of [[["SU"], ["*"]], [["ASU"], ["tenant:admin"]], [["MO"], ["tenant:read"]]]) {
    for (const [method, url] of Z6) {
      if (url === "/api/tenants") continue;
      const other = await request(method, url, asTenant(roles, perms));
      expect({ roles, method, url, status: other.status, violation: other.body?.error?.tenantScopeViolation }).toEqual({ roles, method, url, status: 403, violation: true });
      const own = await request(method, url.replace(B, A), asTenant(roles, perms));
      expect({ roles, method, url, status: own.status, platform: own.body.platform }).toEqual({ roles, method, url, status: 200, platform: null });
    }
    const list = await request("GET", "/api/tenants", asTenant(roles, perms));
    expect([list.status, list.body.platform]).toEqual([200, null]); // the controller confines it to the own tenant
  }
  expect(mockPublished).toEqual([]);
  expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
});

test("users without roles keep the existing policy behaviour; PLATFORM_AUTH_MODE=off -> everyone gets the tenant chain", async () => {
  expect((await request("GET", `/api/tenants/${A}`, asTenant([], []))).body).toEqual({ policy: "tenant:read" });
  process.env.PLATFORM_AUTH_MODE = "off";
  principal.permissions = ALL;
  const r = await request("GET", `/api/tenants/${B}`, asPrincipal());
  expect([r.status, r.body.error.tenantScopeViolation]).toEqual([403, true]); // no platform authority when off
  expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
});

// ── target ──────────────────────────────────────────────────────────────────
test("target: only the :id route parameter; authority first, then 400 (not an id) / 404 (no such tenant)", async () => {
  principal.permissions = [READ];
  const spoof = await request("GET", `/api/tenants/${B}`, asPrincipal({ extra: { "x-target-tenant-id": D, "x-tenant-id": D } }));
  expect(spoof.body.platform.targetTenantId).toBe(B);
  const bodySpoof = await request("PUT", `/api/tenants/${B}?tenantId=${D}`, asPrincipal(), { tenantId: D, targetTenantId: D });
  expect(bodySpoof.status).toBe(403); // read:any only
  principal.permissions = [UPDATE];
  const upd = await request("PUT", `/api/tenants/${B}?tenantId=${D}`, asPrincipal(), { tenantId: D, targetTenantId: D });
  expect(upd.body.platform.targetTenantId).toBe(B);
  principal.permissions = [READ];
  for (const bad of ["default", "unknown", "DEVTENANTB", "39866a06-30bc-4a89-80c6-9dd9357dd453", "6ACD6119B28A863C61361AE0"]) {
    expect({ bad, ...(await request("GET", `/api/tenants/${bad}`, asPrincipal())) }).toEqual({ bad, status: 400, body: { error: { message: "Invalid tenant id", code: "INVALID_TENANT_ID", status: 400 } } });
  }
  expect((await request("GET", `/api/tenants/${MISSING}`, asPrincipal())).status).toBe(404);
  principal.permissions = [];
  // No authority: the same 403 whether or not the tenant exists (existence is never revealed).
  expect((await request("GET", `/api/tenants/${MISSING}`, asPrincipal())).body).toEqual(DENIED);
  expect((await request("GET", "/api/tenants/not-an-id", asPrincipal())).body).toEqual(DENIED);
});

test("req.ctx.tenantId stays the login tenant; req.platform carries the validated target and login context", async () => {
  principal.permissions = [UPDATE];
  const r = await request("PATCH", `/api/tenants/${B}/branding`, asPrincipal());
  expect(r.body.ctxTenant).toBe(A);
  expect(r.body.platform).toEqual({ pid: PID, permission: UPDATE, targetTenantId: B, loginTenantId: A });
});

test("login tenant is context only: same principal via MULTIAUTH or DEVDIRB -> same decisions on DEVTENANTB", async () => {
  for (const held of ALL) {
    principal.permissions = [held];
    for (const [method, url] of Z6) {
      const viaA = await request(method, url, asPrincipal({ login: A, user: UA }));
      const viaD = await request(method, url, asPrincipal({ login: D, user: UD }));
      expect({ method, url, held, status: viaD.status }).toEqual({ method, url, held, status: viaA.status });
      if (viaD.status === 200) expect(viaD.body.platform.loginTenantId).toBe(D);
    }
  }
});

// ── audit ───────────────────────────────────────────────────────────────────
test("audit: every platform decision (allow / deny) -> platform.authz.decision.v1, platform scope, target B, login tenant context", async () => {
  principal.permissions = [READ];
  await request("GET", `/api/tenants/${B}`, asPrincipal());
  await request("PUT", `/api/tenants/${B}`, asPrincipal());
  await flush();
  const d = events("platform.authz.decision.v1");
  expect(d.map((e) => [e.data.allowed, e.data.permission, e.data.status, e.data.reason])).toEqual([[true, READ, 200, "allowed"], [false, UPDATE, 403, "permission_missing"]]);
  for (const e of d) {
    expect(e.opts.auditContext).toEqual({ actorScope: "platform", actorTenantId: null, targetTenantId: B, loginTenantId: A });
    expect(e.opts.tenantId).toBeUndefined(); // never owned by the sign-in tenant (or any tenant)
  }
  expect(events("platform.tenant.admin.changed.v1")).toEqual([]); // reads / denials: no outcome record
  expect(events("tenant.lifecycle.changed.v1")).toEqual([]); // and no tenant copy
});

test("audit: mutations -> outcome record; tenant copy ONLY for approved lifecycle / configuration actions", async () => {
  const COPIED = new Set(["TENANT_UPDATED", "TENANT_STATUS_CHANGED", "AUTH_CONNECTION_ADDED", "AUTH_CONNECTION_UPDATED", "AUTH_CONNECTION_REMOVED", "AUTH_CONNECTION_CONNECTED", "AUTH_CONNECTION_DISCONNECTED"]);
  for (const [method, url, need, change] of Z6.filter((z) => z[3])) {
    mockPublished.length = 0;
    principal.permissions = [need];
    await request(method, url, asPrincipal(), change === "status" ? { status: "PENDING" } : { name: "Acme", clientSecret: "s3cret" });
    await flush();
    const [out] = events("platform.tenant.admin.changed.v1");
    const action = change === "status" ? "TENANT_STATUS_CHANGED" : change;
    expect({ url, action: out.data.action, result: out.data.result, tenant: out.data.tenantId, perm: out.data.permission, pid: out.data.principalId }).toEqual({ url, action, result: "success", tenant: B, perm: need, pid: PID });
    expect(out.opts.auditContext).toEqual({ actorScope: "platform", actorTenantId: null, targetTenantId: B, loginTenantId: A });
    const copies = events("tenant.lifecycle.changed.v1");
    expect({ url, copies: copies.length }).toEqual({ url, copies: COPIED.has(action) ? 1 : 0 });
    if (copies.length) {
      expect(copies[0].opts.tenantId).toBe(B);
      expect(copies[0].opts.auditContext).toEqual({ actorScope: "platform", actorTenantId: null, targetTenantId: B });
      expect(Object.keys(copies[0].data).every((k) => ["tenantId", "action", "section", "connectionId", "fromStatus", "toStatus"].includes(k))).toBe(true);
    }
    expect(JSON.stringify(mockPublished)).not.toMatch(/s3cret|Acme/); // never the request body
  }
});

test("audit: suspend / reactivate are named from the status change; failed mutation -> platform outcome only", async () => {
  principal.permissions = [UPDATE];
  await request("PUT", `/api/tenants/${B}/status`, asPrincipal(), { status: "SUSPENDED" });
  TENANTS[B] = "SUSPENDED";
  await request("PUT", `/api/tenants/${B}/status`, asPrincipal(), { status: "ACTIVE" });
  TENANTS[B] = "ACTIVE";
  await flush();
  expect(events("platform.tenant.admin.changed.v1").map((e) => [e.data.action, e.data.fromStatus, e.data.toStatus])).toEqual([["TENANT_SUSPENDED", "ACTIVE", "SUSPENDED"], ["TENANT_REACTIVATED", "SUSPENDED", "ACTIVE"]]);
  expect(events("tenant.lifecycle.changed.v1").map((e) => e.data.action)).toEqual(["TENANT_SUSPENDED", "TENANT_REACTIVATED"]);
  mockPublished.length = 0;
  await request("PUT", `/api/tenants/${B}`, asPrincipal({ extra: { "x-test-status": "500" } }));
  await flush();
  expect(events("platform.tenant.admin.changed.v1").map((e) => [e.data.result, e.data.status, e.data.reason])).toEqual([["failure", 500, "http_500"]]);
  expect(events("tenant.lifecycle.changed.v1")).toEqual([]);
});

test("delete: platform record only (soft delete; the inactive tenant can no longer sign anyone in to read a copy)", async () => {
  principal.permissions = [DELETE];
  await request("DELETE", `/api/tenants/${B}`, asPrincipal());
  await flush();
  expect(events("platform.tenant.admin.changed.v1").map((e) => e.data.action)).toEqual(["TENANT_DELETED"]);
  expect(events("tenant.lifecycle.changed.v1")).toEqual([]);
});

// ── controller + source guards ───────────────────────────────────────────────
test("getAllTenants: global only with req.platform read:any; every tenant actor keeps its own-tenant filter", async () => {
  const controller = jest.requireActual("../controllers/tenant.controller");
  const TenantHandler = require("../handlers/tenant.handler");
  const seen = [];
  jest.spyOn(TenantHandler, "getAllTenants").mockImplementation(async (f) => (seen.push(f), []));
  const res = () => ({ status() { return this; }, json() { return this; } });
  const withPlatform = (permission) => { const req = { query: {}, ctx: { tenantId: A } }; Object.defineProperty(req, "platform", { value: { permission }, enumerable: false }); return req; };
  await controller.getAllTenants(withPlatform(READ), res(), () => {});
  await controller.getAllTenants(withPlatform(UPDATE), res(), () => {});
  await controller.getAllTenants({ query: {}, ctx: { tenantId: A, roles: ["SU"], permissions: ["*"] } }, res(), () => {});
  expect(seen.map((f) => f.ownTenantId)).toEqual([undefined, A, A]);
});

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
test("no generic platform business-data bypass: req.platform is set only by the platform guards and read only by the tenant controller / audit service / Z2 probe", () => {
  const ROOT = path.join(__dirname, "..");
  const hits = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "tests", ".git", "coverage"].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".js") && /req\??\.platform\b/.test(stripComments(fs.readFileSync(p, "utf8")))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  // Readers: the tenant controller (global list), the audit service, the Z2 DEV probe. Writers: only the two guards
  // (Object.defineProperty(req, "platform", ...) in requirePlatformPermission.js / platformTenantAdmin.js).
  // Phase B / P1: the provisioning controller reads req.platform.pid (actor of a run) - every route reaching it is
  // requirePlatformPermission("platform:provisioning:admin", route-enforce); it is not a business-data bypass.
  expect(hits.sort()).toEqual(["controllers/provisioning.controller.js", "controllers/tenant.controller.js", "routes/platformProbe.routes.js", "services/platformAuditService.js"]);
  const guard = stripComments(fs.readFileSync(path.join(ROOT, "middlewares", "platformTenantAdmin.js"), "utf8"));
  expect(guard).not.toMatch(/x-target-tenant-id|req\.body(?!\?\.status)|req\.query|ctx\.tenantId\s*=[^=]/); // the body is read only for the status-change label
  const routes = stripComments(fs.readFileSync(path.join(ROOT, "routes", "tenant.routes.js"), "utf8"));
  expect((routes.match(/platformTenantAdmin\(/g) || []).length).toBe(20);
  expect(routes).not.toMatch(/x-target-tenant-id/);
});
