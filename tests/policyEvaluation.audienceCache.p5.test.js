/**
 * PDP rollout P5 - a decision cached under one audience mode can never be served under another.
 *   1. user-service token path (evaluatePolicy + the REAL PolicyCache, local store as on DEV with Redis down): the
 *      audience mode is part of the cache identity (decisionEpoch), so a legacy PERMIT cached under off / shadow is a
 *      MISS after the switch to enforce (re-evaluated -> DENY), and the reverse on rollback.
 *   2. calling services (the REAL @membership/policy-middleware PolicyClient over HTTP to the REAL policy router):
 *      its in-memory 5-minute cache has no invalidation signal, so the SAME client instance keeps serving its cached
 *      legacy PERMIT after the switch - which is why the rollout recreates every PDP-calling service on enforce AND
 *      on rollback. A fresh client (= a recreated service) or clearCache() re-evaluates and gets the new decision.
 * Fixture: profile:read with legacy category PORTAL and catalogue audience CRM -> a PORTAL caller is PERMIT under
 * the legacy rule and DENY under enforce.
 */
process.env.REDIS_ENABLED = "false";
process.env.NODE_ENV = "test";
delete process.env.AUTH_BYPASS_ENABLED;

const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

const mockCatalogue = [{ code: "PROFILE_READ", resource: "profile", action: "read", category: "PORTAL", audience: "CRM" }];
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: (roles) => Array.isArray(roles) && roles.includes("ASU"),
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
const { SECRET } = require("./helpers/platformActor");
process.env.JWT_SECRET = process.env.JWT_SECRET || SECRET;
const { PolicyClient } = require("@membership/policy-middleware");

const TA = "68cbf7806080b4621d469d34";
const UID = "68cbf7806080b4621d469d77";
const portalToken = () =>
  jwt.sign({ id: UID, sub: UID, tenantId: TA, userType: "PORTAL", roles: ["MEMBER"], permissions: ["profile:read"] }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
const setMode = (m) => { if (m === undefined) delete process.env.PDP_AUDIENCE_MODE; else process.env.PDP_AUDIENCE_MODE = m; };
const prev = process.env.PDP_AUDIENCE_MODE;

beforeEach(async () => {
  await pdp.cache.clear();
  for (const m of ["log", "info", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); setMode(prev); });

describe("1. user-service decision cache (token path)", () => {
  test("decision epoch carries the mode", () => {
    setMode("off"); const off = pdp.decisionEpoch();
    setMode("shadow"); const sh = pdp.decisionEpoch();
    setMode("enforce"); const en = pdp.decisionEpoch();
    expect(new Set([off, sh, en]).size).toBe(3);
    expect(en).toBe("p5-audience|aud:enforce");
  });

  test.each([["off"], ["shadow"]])("a legacy PERMIT cached under %s is NOT served after the switch to enforce", async (from) => {
    const token = portalToken();
    setMode(from);
    expect(await pdp.evaluatePolicy({ token, resource: "profile", action: "read", context: { tenantId: TA } })).toMatchObject({ decision: "PERMIT" });
    expect(await pdp.evaluatePolicy({ token, resource: "profile", action: "read", context: { tenantId: TA } })).toMatchObject({ decision: "PERMIT", cached: true });
    setMode("enforce");
    const after = await pdp.evaluatePolicy({ token, resource: "profile", action: "read", context: { tenantId: TA } });
    expect(after).toMatchObject({ decision: "DENY" });
    expect(after.cached).toBeUndefined();
  });

  test("rollback (enforce -> shadow): the enforce-time decision is not served; the legacy decision is re-evaluated", async () => {
    const token = portalToken();
    setMode("enforce");
    expect(await pdp.evaluatePolicy({ token, resource: "profile", action: "read", context: { tenantId: TA } })).toMatchObject({ decision: "DENY" });
    setMode("shadow");
    const back = await pdp.evaluatePolicy({ token, resource: "profile", action: "read", context: { tenantId: TA } });
    expect(back).toMatchObject({ decision: "PERMIT" });
    expect(back.cached).toBeUndefined();
  });
});

describe("2. calling services' policy client cache (real policy-middleware over HTTP)", () => {
  let server;
  let baseUrl;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/policy", require("../routes/policy.routes"));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => new Promise((r) => server.close(r)));

  test("the SAME client keeps its cached legacy PERMIT after the switch (no invalidation signal) - callers must be recreated", async () => {
    const token = portalToken();
    setMode("shadow");
    const client = new PolicyClient(baseUrl, { retries: 1, retryDelay: 1 });
    const a = await client.evaluate(token, "profile", "read", { tenantId: TA });
    expect(a).toMatchObject({ decision: "PERMIT" });
    setMode("enforce");
    expect(await client.evaluate(token, "profile", "read", { tenantId: TA })).toBe(a); // stale: the reason for the recreate step
    // a recreated service (fresh client) and an explicit clearCache() both re-evaluate -> the enforced decision
    const fresh = new PolicyClient(baseUrl, { retries: 1, retryDelay: 1 });
    expect(await fresh.evaluate(token, "profile", "read", { tenantId: TA })).toMatchObject({ decision: "DENY" });
    client.clearCache();
    expect(await client.evaluate(token, "profile", "read", { tenantId: TA })).toMatchObject({ decision: "DENY" });
  });
});
