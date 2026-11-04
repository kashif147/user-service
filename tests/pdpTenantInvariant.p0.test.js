/**
 * PDP rollout P0 - the evaluator TENANT INVARIANT (owner-approved; design: mo-reo-pdp-proposal §4, T1-T8).
 *
 * The tenant PDP (services/policyEvaluationService.js) decides only inside the principal's own VERIFIED tenant,
 * for EVERY caller and EVERY resource, including `tenant`:
 *   target / principal tenant missing or blank -> DENY MISSING_TENANT_CONTEXT
 *   String(target) !== String(principal)        -> DENY TENANT_SCOPE_VIOLATION   (applyPolicyRules, Rule 0c)
 *                                               -> DENY TENANT_MISMATCH          (token entry check, Step 4)
 * Order (pinned): platform namespace -> retired SU -> tenant invariant -> ASU own-tenant rule -> resource/action.
 * Platform authority is never decided here: only by requirePlatformPermission / platformTenantAdmin against the
 * explicit allow-list constants/platformPermissions.js.
 *
 * Entry points exercised for real: applyPolicyRules, evaluatePolicy (token path, real PolicyCache local cache),
 * evaluatePolicyWithHeaders (header path), HTTP POST /policy/evaluate (token + gateway-header branches),
 * POST /policy/evaluate-batch, GET /policy/check/:resource/:action, the in-process helpers/policyAdapter.js
 * middleware, and a consuming service through the REAL installed @membership/policy-middleware (PolicyClient +
 * PolicyMiddleware) talking HTTP to the real policy router on an ephemeral port.
 *
 * Secrets are in-test only. The catalogue is a fixture; the `tenant` permissions are category CRM on purpose so
 * the pre-P0 cross-tenant PERMIT is not masked by the TENANT category check (proposal T2).
 */
process.env.REDIS_ENABLED = "false"; // real PolicyCache, local Map fallback (as on DEV with Redis down)
process.env.NODE_ENV = "test";
delete process.env.AUTH_BYPASS_ENABLED;

const http = require("http");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const mockCatalogue = [
  { code: "EVENTS_READ", resource: "events", action: "read", category: "CRM" },
  { code: "LOOKUP_READ", resource: "lookup", action: "read", category: "CRM" },
  { code: "TENANT_READ", resource: "tenant", action: "read", category: "CRM" },
  { code: "TENANT_UPDATE", resource: "tenant", action: "update", category: "CRM" },
];
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: (roles) => Array.isArray(roles) && roles.some((r) => String(typeof r === "string" ? r : r && r.code).trim().toUpperCase() === "ASU"),
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: async () => 1,
  hasMinimumRole: async () => false,
}));
jest.mock("../services/permissionsService", () => ({
  getAllPermissions: async () => mockCatalogue,
  getPermissionsByResource: async (r) => mockCatalogue.filter((p) => p.resource.toLowerCase() === String(r).toLowerCase()),
}));
jest.mock("../services/platformAuditService", () => ({ auditAuthzDecision: () => {}, auditTenantAdminChange: () => {} }));

const pdp = require("../services/policyEvaluationService");
const { applyPolicyRules, evaluatePolicy, evaluatePolicyWithHeaders } = pdp;
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");
const { requirePlatformPermission } = require("../middlewares/requirePlatformPermission");
const { SECRET, bearer, platClaim, installPrincipal } = require("./helpers/platformActor");
const { PolicyClient, PolicyMiddleware } = require("@membership/policy-middleware");

const TA = "68cbf7806080b4621d469d34"; // the principal's own tenant
const TB = "6acd6119b28a863c61361ae0"; // another tenant
const UID = "68cbf7806080b4621d469d99";

const sign = (o = {}) =>
  jwt.sign({ id: UID, sub: UID, tenantId: TA, userType: "CRM", roles: [], permissions: [], ...o }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
const ctx = (o = {}) => ({ roles: [], permissions: ["events:read"], resource: "events", action: "read", tenantId: TA, userTenantId: TA, userType: "CRM", ...o });
const decide = async (o) => applyPolicyRules(ctx(o));
const withMode = async (mode, fn) => {
  const prev = process.env.PDP_TENANT_INVARIANT_MODE;
  if (mode === undefined) delete process.env.PDP_TENANT_INVARIANT_MODE;
  else process.env.PDP_TENANT_INVARIANT_MODE = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PDP_TENANT_INVARIANT_MODE;
    else process.env.PDP_TENANT_INVARIANT_MODE = prev;
  }
};

function policyApp() {
  const app = express();
  app.use(express.json());
  app.use("/policy", require("../routes/policy.routes"));
  // In-process consumer of the same evaluator (user-service's own tenant routes use this adapter).
  app.put("/adapter/tenant", defaultPolicyAdapter.middleware("tenant", "update"), (req, res) => res.json({ ok: true, tenantId: req.tenantId }));
  app.get("/adapter/events", defaultPolicyAdapter.middleware("events", "read"), (req, res) => res.json({ ok: true, tenantId: req.tenantId }));
  // A platform operation, exactly as the platform routes mount it (explicit allow-list code, route-enforce).
  app.get(
    "/platform/tenants",
    (req, res, next) => {
      const d = jwt.decode(String(req.headers.authorization || "").replace(/^Bearer /, "")) || {};
      req.ctx = { tenantId: d.tenantId, userId: d.id };
      next();
    },
    requirePlatformPermission("platform:tenant:read:any", { mode: "route-enforce" }),
    (req, res) => res.json({ ok: true, platform: !!req.platform })
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || err.statusCode || 500).json({ error: err.message }));
  return app;
}

beforeEach(async () => {
  process.env.JWT_SECRET = SECRET;
  delete process.env.PDP_TENANT_INVARIANT_MODE;
  delete process.env.PLATFORM_AUTH_MODE;
  await pdp.cache.clear();
  for (const m of ["log", "info", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("flag", () => {
  test("default is enforce; unknown values fail closed to enforce; off/shadow are explicit", () => {
    expect(pdp.tenantInvariantMode()).toBe("enforce");
    for (const [raw, mode] of [["off", "off"], ["SHADOW", "shadow"], [" enforce ", "enforce"], ["disabled", "enforce"], ["", "enforce"]]) {
      process.env.PDP_TENANT_INVARIANT_MODE = raw;
      expect(pdp.tenantInvariantMode()).toBe(mode);
    }
  });
  test("decision-cache epoch was bumped for the new semantics", () => {
    expect(pdp.PDP_DECISION_EPOCH).toBe("p0-tenant-invariant");
  });
});

describe("core evaluator (applyPolicyRules): T1-T7 and the owner-required cases", () => {
  test("T1 non-ASU CRM holding events:read, tenantId != userTenantId -> DENY TENANT_SCOPE_VIOLATION (pre-P0: PERMIT)", async () => {
    expect(await decide({ tenantId: TB })).toEqual({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
    expect(await decide({ tenantId: TA, userTenantId: TB })).toEqual({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
    // The test bites: with the invariant off (rollback) the pre-P0 defect is back.
    expect(await withMode("off", () => decide({ tenantId: TB }))).toMatchObject({ decision: "PERMIT" });
    // Own tenant is unchanged.
    expect(await decide({})).toMatchObject({ decision: "PERMIT", reason: "POLICY_SATISFIED" });
  });

  test("`tenant` resource cross-tenant, non-ASU with tenant:read/update -> DENY", async () => {
    for (const action of ["read", "update"]) {
      expect(await decide({ resource: "tenant", action, permissions: [`tenant:${action}`], tenantId: TB })).toEqual({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
      expect(await decide({ resource: "tenant", action, permissions: [`tenant:${action}`] })).toMatchObject({ decision: "PERMIT" });
    }
    expect(await withMode("off", () => decide({ resource: "tenant", permissions: ["tenant:read"], tenantId: TB }))).toMatchObject({ decision: "PERMIT" });
  });

  test("T3 ASU cross-tenant, any resource -> DENY TENANT_SCOPE_VIOLATION, in every mode", async () => {
    for (const mode of [undefined, "shadow", "off"]) {
      for (const resource of ["events", "tenant", "lookup", "anything"]) {
        for (const permissions of [[], ["*"]]) {
          expect(await withMode(mode, () => decide({ roles: ["ASU"], resource, permissions, tenantId: TB }))).toEqual({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
        }
      }
    }
  });

  test("ASU own tenant -> PERMIT ASU_OWN_TENANT_ADMIN (incl. the `tenant` resource)", async () => {
    for (const resource of ["events", "tenant", "lookup"]) {
      expect(await decide({ roles: ["ASU"], resource, permissions: [] })).toEqual({ decision: "PERMIT", reason: "ASU_OWN_TENANT_ADMIN" });
    }
  });

  test("T4 missing / blank tenant on either side -> DENY MISSING_TENANT_CONTEXT (ASU and non-ASU)", async () => {
    for (const roles of [[], ["ASU"]]) {
      for (const blank of [undefined, null, "", "   "]) {
        expect(await decide({ roles, tenantId: blank })).toEqual({ decision: "DENY", reason: "MISSING_TENANT_CONTEXT" });
        expect(await decide({ roles, userTenantId: blank })).toEqual({ decision: "DENY", reason: "MISSING_TENANT_CONTEXT" });
      }
    }
  });

  test("T5 same tenant as String vs ObjectId -> PERMIT (string compare)", async () => {
    expect(await decide({ tenantId: new mongoose.Types.ObjectId(TA), userTenantId: TA })).toMatchObject({ decision: "PERMIT" });
    expect(await decide({ tenantId: TA, userTenantId: new mongoose.Types.ObjectId(TA) })).toMatchObject({ decision: "PERMIT" });
    expect(await decide({ tenantId: new mongoose.Types.ObjectId(TB), userTenantId: TA })).toEqual({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
  });

  test("T6 platform namespace from ASU / \"*\" (tenant principals) -> DENY PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE, before the tenant check", async () => {
    for (const roles of [["ASU"], []]) {
      for (const tenantId of [TA, TB]) {
        for (const [resource, action] of [["platform", "tenant:read:any"], ["platform:tenant", "read:any"], ["platform", "cache:admin"]]) {
          expect(await decide({ roles, permissions: ["*"], resource, action, tenantId })).toEqual({ decision: "DENY", reason: "PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE" });
        }
      }
    }
  });

  test("T7 token carrying the retired SU -> DENY RETIRED_ROLE_REAUTH_REQUIRED (own or other tenant)", async () => {
    for (const tenantId of [TA, TB]) {
      expect(await decide({ roles: ["SU"], permissions: ["*"], tenantId })).toEqual({ decision: "DENY", reason: "RETIRED_ROLE_REAUTH_REQUIRED" });
      expect(await decide({ roles: [{ code: "su" }, "ASU"], permissions: ["*"], tenantId })).toEqual({ decision: "DENY", reason: "RETIRED_ROLE_REAUTH_REQUIRED" });
    }
  });

  test("shadow returns the pre-P0 decision and logs a masked divergence (no roles/permissions/full ids)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await withMode("shadow", () => decide({ tenantId: TB }))).toMatchObject({ decision: "PERMIT" });
    const line = warn.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("pdp.tenant_invariant.shadow"));
    expect(line).toBeDefined();
    expect(line).toContain("TENANT_SCOPE_VIOLATION");
    expect(line).not.toContain(TA);
    expect(line).not.toContain(TB);
    expect(line).not.toContain("events:read");
  });
});

describe("token path (evaluatePolicy) incl. the cache - T2, T8", () => {
  test("T2 non-ASU CRM with tenant:read, context.tenantId = other tenant -> DENY (pre-P0: PERMIT via the `tenant` skip)", async () => {
    const token = sign({ permissions: ["tenant:read"] });
    expect(await evaluatePolicy({ token, resource: "tenant", action: "read", context: { tenantId: TB } })).toMatchObject({ decision: "DENY", reason: "TENANT_MISMATCH" });
    expect(await evaluatePolicy({ token, resource: "tenant", action: "read", context: { tenantId: TA } })).toMatchObject({ decision: "PERMIT" });
    await pdp.cache.clear();
    expect(await withMode("off", () => evaluatePolicy({ token, resource: "tenant", action: "read", context: { tenantId: TB } }))).toMatchObject({ decision: "PERMIT" });
  });

  test("non-`tenant` resource cross-tenant stays DENY TENANT_MISMATCH in every mode (unchanged)", async () => {
    const token = sign({ permissions: ["events:read"] });
    for (const mode of [undefined, "shadow", "off"]) {
      expect(await withMode(mode, () => evaluatePolicy({ token, resource: "events", action: "read", context: { tenantId: TB } }))).toMatchObject({ decision: "DENY", reason: "TENANT_MISMATCH" });
    }
  });

  test("missing tenant in the token -> DENY (fail closed)", async () => {
    const token = jwt.sign({ id: UID, userType: "CRM", roles: [], permissions: ["events:read"] }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
    expect(await evaluatePolicy({ token, resource: "events", action: "read", context: { tenantId: TA } })).toMatchObject({ decision: "DENY" });
  });

  test("T8 same identity: a PERMIT cached for tenant A is never reused for a tenant B context", async () => {
    const setSpy = jest.spyOn(pdp.cache, "set");
    const token = sign({ permissions: ["tenant:read"] });
    const a = await evaluatePolicy({ token, resource: "tenant", action: "read", context: { tenantId: TA } });
    expect(a).toMatchObject({ decision: "PERMIT" });
    await new Promise((r) => setImmediate(r));
    const a2 = await evaluatePolicy({ token, resource: "tenant", action: "read", context: { tenantId: TA } });
    expect(a2).toMatchObject({ decision: "PERMIT", cached: true }); // the cache is live
    const b = await evaluatePolicy({ token, resource: "tenant", action: "read", context: { tenantId: TB } });
    expect(b).toMatchObject({ decision: "DENY", reason: "TENANT_MISMATCH" });
    expect(b.cached).toBeUndefined();
    // The key carries the target tenant: an A-key and a B-key differ.
    const keyA = pdp.cache.generateKey("d", "tenant", "read", { tenantId: TA });
    const keyB = pdp.cache.generateKey("d", "tenant", "read", { tenantId: TB });
    expect(keyA).not.toEqual(keyB);
    expect(setSpy.mock.calls.every(([k]) => String(k).startsWith(`${TA}:`))).toBe(true);
  });

  test("shadow: the cross-tenant PERMIT it still returns is NOT cached, so shadow -> enforce takes effect at once", async () => {
    const setSpy = jest.spyOn(pdp.cache, "set");
    const token = sign({ permissions: ["tenant:read"] });
    const r = await withMode("shadow", () => evaluatePolicy({ token, resource: "tenant", action: "read", context: { tenantId: TB } }));
    expect(r).toMatchObject({ decision: "PERMIT" });
    await new Promise((res) => setImmediate(res));
    expect(setSpy.mock.calls.filter(([k]) => String(k).startsWith(`${TB}:`))).toHaveLength(0);
    expect(await evaluatePolicy({ token, resource: "tenant", action: "read", context: { tenantId: TB } })).toMatchObject({ decision: "DENY" });
  });
});

describe("header path (evaluatePolicyWithHeaders)", () => {
  const headers = (o = {}) => ({
    "x-user-id": UID,
    "x-tenant-id": TA,
    "x-user-type": "CRM",
    "x-user-roles": "[]",
    "x-user-permissions": JSON.stringify(["tenant:read", "events:read"]),
    ...o,
  });
  test("a caller context tenant is ignored: the decision is always own-tenant (cross-tenant is not expressible)", async () => {
    expect(await evaluatePolicyWithHeaders({ headers: headers(), resource: "tenant", action: "read", context: { tenantId: TB } })).toMatchObject({ decision: "PERMIT" });
    expect(await evaluatePolicyWithHeaders({ headers: headers({ "x-user-roles": "[\"ASU\"]" }), resource: "events", action: "read", context: { tenantId: TB } })).toMatchObject({ decision: "PERMIT", reason: "ASU_OWN_TENANT_ADMIN" });
  });
  test("missing x-tenant-id -> DENY", async () => {
    expect(await evaluatePolicyWithHeaders({ headers: headers({ "x-tenant-id": undefined }), resource: "events", action: "read" })).toMatchObject({ decision: "DENY", reason: "INVALID_HEADERS" });
  });
  test("platform namespace / retired SU still refused on the header path", async () => {
    expect(await evaluatePolicyWithHeaders({ headers: headers({ "x-user-permissions": "[\"*\"]", "x-user-roles": "[\"ASU\"]" }), resource: "platform", action: "tenant:read:any" })).toMatchObject({ decision: "DENY", reason: "PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE" });
    expect(await evaluatePolicyWithHeaders({ headers: headers({ "x-user-roles": "[\"SU\"]" }), resource: "events", action: "read" })).toMatchObject({ decision: "DENY", reason: "RETIRED_ROLE_REAUTH_REQUIRED" });
  });
});

describe("HTTP entry points (real policy router + real adapter)", () => {
  // Bound to 127.0.0.1 explicitly (not supertest's wildcard ephemeral listener, which on macOS can share a port
  // number with another process's loopback listener).
  let server;
  let app;
  beforeAll(async () => {
    server = http.createServer(policyApp());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    app = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => new Promise((r) => server.close(r)));
  const token = () => sign({ permissions: ["tenant:read", "tenant:update", "events:read"] });

  test("POST /policy/evaluate (token branch): `tenant` cross-tenant 403, own tenant 200", async () => {
    const deny = await request(app).post("/policy/evaluate").send({ token: token(), resource: "tenant", action: "read", context: { tenantId: TB } });
    expect(deny.status).toBe(403);
    expect(deny.body).toMatchObject({ authorized: false, decision: "DENY", reason: "TENANT_MISMATCH" });
    const ok = await request(app).post("/policy/evaluate").send({ token: token(), resource: "tenant", action: "read", context: { tenantId: TA } });
    expect(ok.status).toBe(200);
  });

  test("POST /policy/evaluate (gateway-header branch): body context tenant ignored, decision own-tenant", async () => {
    const res = await request(app)
      .post("/policy/evaluate")
      .set({ "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": UID, "x-tenant-id": TA, "x-user-type": "CRM", "x-user-roles": "[]", "x-user-permissions": "[\"tenant:read\"]" })
      .send({ resource: "tenant", action: "read", context: { tenantId: TB } });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ tenantId: TA });
  });

  test("POST /policy/evaluate-batch: per-request decision, cross-tenant entries DENY", async () => {
    const t = token();
    const res = await request(app).post("/policy/evaluate-batch").send({
      requests: [
        { token: t, resource: "tenant", action: "read", context: { tenantId: TA } },
        { token: t, resource: "tenant", action: "read", context: { tenantId: TB } },
        { token: t, resource: "events", action: "read", context: { tenantId: TB } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => [r.decision, r.reason])).toEqual([
      ["PERMIT", expect.any(String)],
      ["DENY", "TENANT_MISMATCH"],
      ["DENY", "TENANT_MISMATCH"],
    ]);
  });

  test("GET /policy/check/tenant/read?tenantId=<other> -> 403", async () => {
    const deny = await request(app).get(`/policy/check/tenant/read?tenantId=${TB}`).set("Authorization", `Bearer ${token()}`);
    expect(deny.status).toBe(403);
    const ok = await request(app).get(`/policy/check/tenant/read?tenantId=${TA}`).set("Authorization", `Bearer ${token()}`);
    expect(ok.status).toBe(200);
  });

  test("in-process policyAdapter: a body/query tenantId for another tenant can no longer pass the `tenant` check", async () => {
    const deny = await request(app).put("/adapter/tenant").set("Authorization", `Bearer ${token()}`).send({ tenantId: TB, name: "x" });
    expect(deny.status).toBe(403);
    const denyQ = await request(app).put(`/adapter/tenant?tenantId=${TB}`).set("Authorization", `Bearer ${token()}`).send({ name: "x" });
    expect(denyQ.status).toBe(403);
    const ok = await request(app).put("/adapter/tenant").set("Authorization", `Bearer ${token()}`).send({ name: "x" });
    expect(ok.status).toBe(200);
    expect(ok.body.tenantId).toBe(TA);
    // Pre-P0 behaviour (rollback switch) for the record.
    const off = await withMode("off", () => request(app).put("/adapter/tenant").set("Authorization", `Bearer ${token()}`).send({ tenantId: TB }));
    expect(off.status).toBe(200);
  });

  test("platform principal: platform op permitted by the platform evaluator; tenant op for another tenant denied by the tenant PDP", async () => {
    process.env.PLATFORM_AUTH_MODE = "enforce";
    installPrincipal({ permissions: ["platform:tenant:read:any"], userId: UID, tenantId: TA });
    const plat = bearer({ userId: UID, tenantId: TA, roles: [], permissions: [], plat: platClaim(1) });
    const p = await request(app).get("/platform/tenants").set("Authorization", plat);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ ok: true, platform: true });
    // The same principal on the TENANT PDP: platform authority does not carry over, cross-tenant is refused.
    const raw = plat.replace(/^Bearer /, "");
    const t = await request(app).post("/policy/evaluate").send({ token: raw, resource: "tenant", action: "read", context: { tenantId: TB } });
    expect(t.status).toBe(403);
    expect(await applyPolicyRules(ctx({ resource: "tenant", permissions: ["platform:tenant:read:any"], tenantId: TB }))).toEqual({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
    // Own tenant: only an explicit tenant permission would admit it - the platform code does not.
    expect(await applyPolicyRules(ctx({ resource: "tenant", permissions: ["platform:tenant:read:any"] }))).toMatchObject({ decision: "DENY" });
    // A tenant principal (no platform claim) on the platform op -> 403.
    const tenantActor = await request(app).get("/platform/tenants").set("Authorization", bearer({ userId: UID, tenantId: TA, roles: ["ASU"], permissions: ["*"] }));
    expect(tenantActor.status).toBe(403);
  });
});

describe("consuming service through the real @membership/policy-middleware (HTTP to the real policy router)", () => {
  let server;
  let baseUrl;
  beforeAll(async () => {
    server = http.createServer(policyApp());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => new Promise((r) => server.close(r)));

  test("PolicyClient: own tenant PERMIT, then the same token for another tenant -> DENY (no client-cache reuse)", async () => {
    const client = new PolicyClient(baseUrl, { retries: 1, retryDelay: 1 });
    const token = sign({ permissions: ["tenant:read"] });
    const a = await client.evaluate(token, "tenant", "read", { tenantId: TA });
    expect(a).toMatchObject({ success: true, decision: "PERMIT" });
    const a2 = await client.evaluate(token, "tenant", "read", { tenantId: TA });
    expect(a2).toBe(a); // served from the client cache
    const b = await client.evaluate(token, "tenant", "read", { tenantId: TB });
    expect(b).toMatchObject({ success: false, decision: "DENY", reason: "TENANT_MISMATCH" });
    expect(client.getCacheKey(token, "tenant", "read", { tenantId: TA })).not.toEqual(client.getCacheKey(token, "tenant", "read", { tenantId: TB }));
    // hasPermission (the client API that forwards a caller-chosen target) is DENY too.
    const mw = new PolicyMiddleware(baseUrl, { retries: 1, retryDelay: 1 });
    expect(await mw.hasPermission(token, "tenant", "read", { tenantId: TB })).toBe(false);
    expect(await mw.hasPermission(token, "tenant", "read", { tenantId: TA })).toBe(true);
  });

  test("PolicyMiddleware.requirePermission on a consuming app: a body tenantId for another tenant never yields a cross-tenant PERMIT", async () => {
    const mw = new PolicyMiddleware(baseUrl, { retries: 1, retryDelay: 1 });
    const consumer = express();
    consumer.use(express.json());
    consumer.post("/thing", mw.requirePermission("tenant", "read"), (req, res) => res.json({ tenantId: req.tenantId }));
    const token = sign({ permissions: ["tenant:read"] });
    // Bearer path: the middleware re-asserts the trusted tenant, the PDP decides in the token's own tenant.
    const r1 = await request(consumer).post("/thing").set("Authorization", `Bearer ${token}`).send({ tenantId: TB });
    expect(r1.status).toBe(200);
    expect(r1.body.tenantId).toBe(TA);
    // Gateway-header path: same, the decision is own-tenant.
    const r2 = await request(consumer)
      .post("/thing")
      .set({ "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": UID, "x-tenant-id": TA, "x-user-type": "CRM", "x-user-roles": "[]", "x-user-permissions": "[\"tenant:read\"]" })
      .send({ tenantId: TB });
    expect(r2.status).toBe(200);
    expect(r2.body.tenantId).toBe(TA);
    // A token without the permission is still refused end to end.
    const r3 = await request(consumer).post("/thing").set("Authorization", `Bearer ${sign({ permissions: [] })}`).send({});
    expect(r3.status).toBe(403);
  });
});
