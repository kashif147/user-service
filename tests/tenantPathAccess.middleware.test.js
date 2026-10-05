/**
 * Phase 1C-2B — middlewares/auth.js requireTenantPathAccess(paramName).
 *
 * The named path param must equal the trusted req.ctx.tenantId unless the trusted roles include SU.
 * Fails closed without a trusted tenant; never reads body/query/header tenant hints.
 *
 * No DB/Redis/network: policy-middleware and roleHierarchyService are mocked (same as
 * auth.authenticate.test.js) so the real auth.js can be required.
 */
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: () => false,
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1,
  hasMinimumRole: () => false,
}));

const { requireTenantPathAccess, requireSuperUser } = require("../middlewares/auth");

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";

function run(mw, { ctx, params = {}, body, query, headers = {} }) {
  const req = { ctx, params, body, query, headers, originalUrl: "/api/x" };
  const res = {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nextCalls = 0;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  mw(req, res, () => { nextCalls += 1; });
  warn.mockRestore();
  return { res, nextCalls };
}

describe("requireTenantPathAccess", () => {
  const byTenantId = requireTenantPathAccess("tenantId");
  const byId = requireTenantPathAccess("id");

  test("A same-tenant :tenantId passes", () => {
    const { nextCalls, res } = run(byTenantId, { ctx: { tenantId: A, roles: ["ASU"] }, params: { tenantId: A } });
    expect(nextCalls).toBe(1);
    expect(res.statusCode).toBeNull();
  });

  test("B cross-tenant :tenantId is 403 for non-SU (ASU, plain user)", () => {
    for (const roles of [["ASU"], ["MEMBER"], []]) {
      const { nextCalls, res } = run(byTenantId, { ctx: { tenantId: A, roles }, params: { tenantId: B } });
      expect(nextCalls).toBe(0);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toMatchObject({ code: "FORBIDDEN", tenantScopeViolation: true });
    }
  });

  test("C SU may access another tenant (role codes or role objects)", () => {
    for (const roles of [["SU"], [{ code: "SU" }], ["ASU", "SU"]]) {
      const { nextCalls } = run(byTenantId, { ctx: { tenantId: A, roles }, params: { tenantId: B } });
      expect(nextCalls).toBe(1);
    }
  });

  test("D same contract for the :id parameter name", () => {
    expect(run(byId, { ctx: { tenantId: A, roles: [] }, params: { id: A } }).nextCalls).toBe(1);
    expect(run(byId, { ctx: { tenantId: A, roles: [] }, params: { id: B } }).res.statusCode).toBe(403);
    expect(run(byId, { ctx: { tenantId: A, roles: ["SU"] }, params: { id: B } }).nextCalls).toBe(1);
    // the guard reads only the param it was configured with
    expect(run(byId, { ctx: { tenantId: A, roles: [] }, params: { tenantId: A } }).res.statusCode).toBe(403);
  });

  test("E fails closed without a trusted tenant (even for SU) and when the param is absent", () => {
    for (const ctx of [undefined, {}, { tenantId: "" }, { tenantId: null, roles: ["SU"] }]) {
      const { nextCalls, res } = run(byTenantId, { ctx, params: { tenantId: A } });
      expect(nextCalls).toBe(0);
      expect(res.statusCode).toBe(403);
    }
    expect(run(byTenantId, { ctx: { tenantId: A, roles: [] }, params: {} }).res.statusCode).toBe(403);
  });

  test("F body/query/header tenant hints cannot affect the decision", () => {
    const hints = { body: { tenantId: B }, query: { tenantId: B }, headers: { "x-tenant-id": B } };
    // same-tenant path still passes despite hints naming another tenant
    expect(run(byTenantId, { ctx: { tenantId: A, roles: [] }, params: { tenantId: A }, ...hints }).nextCalls).toBe(1);
    // cross-tenant path is still denied even when every hint matches the path tenant
    const sameAsPath = { body: { tenantId: B }, query: { tenantId: B }, headers: { "x-tenant-id": B } };
    expect(run(byTenantId, { ctx: { tenantId: A, roles: [] }, params: { tenantId: B }, ...sameAsPath }).res.statusCode).toBe(403);
  });

  test("compares normalized string values (ObjectId-like ctx, surrounding whitespace)", () => {
    const oidLike = { toString: () => A };
    expect(run(byTenantId, { ctx: { tenantId: oidLike, roles: [] }, params: { tenantId: ` ${A} ` } }).nextCalls).toBe(1);
  });

  test("requires an explicit parameter name", () => {
    expect(() => requireTenantPathAccess()).toThrow(/explicit path parameter/);
  });
});

describe("requireSuperUser", () => {
  test("SU (code or object) with a trusted tenant passes", () => {
    for (const roles of [["SU"], [{ code: "SU" }]]) {
      expect(run(requireSuperUser, { ctx: { tenantId: A, roles } }).nextCalls).toBe(1);
    }
  });

  test("non-SU is 403; SU claims in body/query/header are ignored", () => {
    const { nextCalls, res } = run(requireSuperUser, {
      ctx: { tenantId: A, roles: ["ASU"] },
      body: { roles: ["SU"] },
      query: { role: "SU" },
      headers: { "x-user-roles": '["SU"]' },
    });
    expect(nextCalls).toBe(0);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatchObject({ code: "FORBIDDEN", superUserRequired: true });
  });

  test("fails closed without a trusted tenant context", () => {
    for (const ctx of [undefined, { roles: ["SU"] }]) {
      expect(run(requireSuperUser, { ctx }).res.statusCode).toBe(403);
    }
  });
});
