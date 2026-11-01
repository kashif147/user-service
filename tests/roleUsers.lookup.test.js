/**
 * POST /api/users/lookup - id -> display name for users referenced by issue records
 * (issue-service createdBy / owner.userId / resolvedByUserId).
 *
 * Mounts the REAL routes/role.routes.js + RoleController + RoleHandler + response.mw; models
 * are stubs. Proves: tenant-scoped query, only display fields selected/returned, invalid ids
 * dropped, caps enforced, gated on issues:read (owner decision 2026-10-31), not user:read.
 */
const http = require("http");
const express = require("express");

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const U1 = "111111111111111111111111";
const U2 = "222222222222222222222222";
const U3 = "333333333333333333333333";
const mockState = { queries: [], selects: [], fail: false };
const mockUsers = [
  { _id: U1, tenantId: A, userEmail: "jane@x", userFirstName: "Jane", userLastName: "Doe", userFullName: "Jane Doe", roles: ["r1"], password: "HASH" },
  { _id: U2, tenantId: A, userEmail: "bob@x", userFirstName: "Bob", userLastName: "Ray", userFullName: null, roles: [] },
  { _id: U3, tenantId: B, userEmail: "other@x", userFullName: "Other Tenant", roles: [] },
];

jest.mock("../models/user.model", () => ({
  find: (q) => {
    mockState.queries.push(q);
    const c = {
      select: (f) => (mockState.selects.push(f), c),
      lean: () => Promise.resolve().then(() => {
        if (mockState.fail) throw new Error("DB_INTERNAL_MARKER");
        const ids = (q._id && q._id.$in) || [];
        return mockUsers.filter((u) => u.tenantId === q.tenantId && ids.includes(u._id));
      }),
    };
    return c;
  },
  findOne: async () => null,
}));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("../models/role.model", () => ({}));
jest.mock("../models/permission.model", () => ({}));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: () => false, isAssistantSuperUser: () => false, isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1, hasMinimumRole: () => false,
}));
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => {
      const fn = (req, res, next) => next();
      Object.defineProperty(fn, "name", { value: `policy:${resource}:${action}` });
      return fn;
    },
  },
}));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    tenantContextWarn: (req, res, next) => next(),
    authenticate: function authenticate(req, res, next) {
      const t = req.headers["x-test-tenant"];
      if (t) req.ctx = { tenantId: t, userId: "actor-1", roles: ["IRO"], permissions: ["issues:read"] };
      next();
    },
  };
});

const responseMiddleware = require("../middlewares/response.mw");

let server;
let port;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use("/api", require("../routes/role.routes"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || err.statusCode || 500).json({ message: err.message }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  mockState.queries = []; mockState.selects = []; mockState.fail = false;
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const post = (body, tenant = A) => new Promise((resolve) => {
  const payload = JSON.stringify(body);
  const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
  if (tenant) headers["x-test-tenant"] = tenant;
  const rq = http.request({ port, method: "POST", path: "/api/users/lookup", headers, timeout: 3000 }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, raw: b, body: JSON.parse(b) }));
  });
  rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
  rq.end(payload);
});

test("returns only id/fullName/email for the caller's tenant; composes name when userFullName empty", async () => {
  const r = await post({ ids: [U1, U2, U3, U1] });
  expect(r.status).toBe(200);
  expect(mockState.queries).toEqual([{ _id: { $in: [U1, U2, U3] }, tenantId: A }]);
  expect(mockState.selects).toEqual(["_id userEmail userFirstName userLastName userFullName"]);
  expect(r.body).toEqual({
    status: "success",
    data: [
      { _id: U1, fullName: "Jane Doe", email: "jane@x" },
      { _id: U2, fullName: "Bob Ray", email: "bob@x" },
    ],
  });
  expect(r.raw).not.toMatch(/Other Tenant|HASH|roles/);
});

test("invalid / non-ObjectId ids are dropped; none valid -> empty without querying", async () => {
  const r = await post({ ids: ["not-an-id", "", null, "abcdefabcdef"] });
  expect(r.status).toBe(200);
  expect(r.body.data).toEqual([]);
  expect(mockState.queries).toEqual([]);
});

test("ids must be an array (400)", async () => {
  const r = await post({ ids: U1 });
  expect(r.status).toBe(400);
  expect(mockState.queries).toEqual([]);
});

test("more than 500 ids rejected (400)", async () => {
  const r = await post({ ids: Array.from({ length: 501 }, () => U1) });
  expect(r.status).toBe(400);
  expect(mockState.queries).toEqual([]);
});

test("missing tenant rejected before the controller (400)", async () => {
  const r = await post({ ids: [U1] }, null);
  expect(r.status).toBe(400);
  expect(mockState.queries).toEqual([]);
});

test("DB failure -> generic 500, no internal text", async () => {
  mockState.fail = true;
  const r = await post({ ids: [U1] });
  expect(r.status).toBe(500);
  expect(r.raw).not.toContain("DB_INTERNAL_MARKER");
});

test("route wiring: POST /users/lookup is gated on issues:read (not user:read)", () => {
  const router = require("../routes/role.routes");
  const layer = router.stack.find((l) => l.route && l.route.path === "/users/lookup" && l.route.methods.post);
  expect(layer.route.stack.map((x) => x.name)[0]).toBe("policy:issues:read");
  expect(layer.route.stack[1].handle).toBe(require("../controllers/role.controller").lookupUserDisplayNames);
});
