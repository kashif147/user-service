/**
 * Phase 1C-2U — RoleController.getAllUsers (GET /api/users) error text and logging.
 *
 * Before: the 500 public message embedded the raw exception ("Failed to retrieve users: <error>"),
 * which the 1C-2S diagnostics allow-list cannot hide (it is the AppError message itself), and every
 * call logged the whole req.ctx (including the caller's roles/permissions arrays).
 * After: 500 message is "Failed to retrieve users"; the full error is still logged server-side; the
 * context log carries only { tenantId, userId, correlationId }. The success path is unchanged.
 *
 * Mounts the REAL routes/role.routes.js + RoleController + response.mw, and the final error handler
 * taken verbatim from app.js (app.js itself opens DB/Redis). NODE_ENV=staging. Models are stubs.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const MARK = "ROLE_USERS_INTERNAL_MARKER redis://secret-host:6379 /srv/private/users.js";
const mockState = { fail: null, queries: [], populate: [], select: [] };
const mockUsers = [
  { _id: "u1", tenantId: A, userEmail: "a1@x", isActive: true, roles: ["r1"], password: "HASH", tokens: ["T"] },
  { _id: "u2", tenantId: A, userEmail: "a2@x", isActive: false, roles: [], password: "HASH", tokens: [] },
  { _id: "u3", tenantId: B, userEmail: "b1@x", isActive: true, roles: ["r9"], password: "HASH", tokens: [] },
];

jest.mock("../models/user.model", () => ({
  find: (q) => {
    mockState.queries.push(q);
    const rows = () => mockUsers.filter((u) => u.tenantId === q.tenantId).map((u) => {
      const o = { ...u };
      if (mockState.select.includes("-password -tokens")) { delete o.password; delete o.tokens; }
      if (mockState.populate.includes("roles")) o.roles = o.roles.map((r) => ({ _id: r, code: r.toUpperCase() }));
      return { toObject: () => o };
    });
    const c = {
      populate: (f) => (mockState.populate.push(f), c),
      select: (f) => (mockState.select.push(f), c),
      then: (a, b) => Promise.resolve().then(() => { if (mockState.fail === "users") throw new Error(MARK); return rows(); }).then(a, b),
    };
    return c;
  },
  findOne: async () => null,
}));
jest.mock("../models/tenant.model", () => ({
  findById: (id) => ({
    select: () => ({
      then: (a, b) => Promise.resolve().then(() => {
        if (mockState.fail === "tenant") throw new Error(MARK);
        return { _id: id, name: "INMO" };
      }).then(a, b),
    }),
  }),
}));
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
      if (t) req.ctx = { tenantId: t, userId: "actor-1", roles: ["MO", "ROLE_ARRAY_MARKER"], permissions: ["user:read", "PERMISSION_ARRAY_MARKER"] };
      next();
    },
  };
});

const responseMiddleware = require("../middlewares/response.mw");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const hStart = appSrc.indexOf("app.use((err, req, res, next) => {");
const hEnd = appSrc.indexOf("\n});\n", hStart) + 4;
// eslint-disable-next-line no-new-func
const finalHandler = new Function("crypto", "responseMiddleware", `return (${appSrc.slice(hStart + "app.use(".length, hEnd - 1).trim().replace(/\)$/, "")});`)(crypto, responseMiddleware);

let server;
let port;
const unhandled = [];
const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
const ORIGINAL_ENV = process.env.NODE_ENV;
let logs;
beforeAll(async () => {
  process.env.NODE_ENV = "staging";
  process.on("unhandledRejection", onUnhandled);
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use((req, res, next) => { req.correlationId = req.headers["x-correlation-id"]; next(); });
  app.use("/api", require("../routes/role.routes"));
  app.use(finalHandler);
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
  process.off("unhandledRejection", onUnhandled);
  return new Promise((r) => server.close(r));
});
beforeEach(() => {
  mockState.fail = null; mockState.queries = []; mockState.populate = []; mockState.select = [];
  unhandled.length = 0;
  logs = [];
  const capture = (level) => (...a) => logs.push(`${level} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")}`);
  jest.spyOn(console, "log").mockImplementation(capture("log"));
  jest.spyOn(console, "error").mockImplementation(capture("error"));
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  expect(unhandled).toEqual([]);
  jest.restoreAllMocks();
});

const get = (tenant = A) => new Promise((resolve) => {
  const headers = { "x-correlation-id": "cid-1" };
  if (tenant) headers["x-test-tenant"] = tenant;
  const rq = http.get({ port, path: "/api/users", headers, timeout: 3000 }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, raw: b, body: JSON.parse(b) }));
  });
  rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
});

describe("success path unchanged", () => {
  test("200 {status:'success', data}; tenant-scoped query; roles populated; password/tokens excluded; deactivated included", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(mockState.queries).toEqual([{ tenantId: A }]);
    expect(mockState.populate).toEqual(["roles"]);
    expect(mockState.select).toEqual(["-password -tokens"]);
    expect(r.body).toEqual({
      status: "success",
      data: [
        { _id: "u1", tenantId: A, userEmail: "a1@x", isActive: true, roles: [{ _id: "r1", code: "R1" }], tenantName: "INMO" },
        { _id: "u2", tenantId: A, userEmail: "a2@x", isActive: false, roles: [], tenantName: "INMO" },
      ],
    });
  });
  test("another tenant's users are never returned", async () => {
    const r = await get(A);
    expect(r.body.data.map((u) => u.tenantId)).toEqual([A, A]);
    expect(r.raw).not.toContain("b1@x");
  });
  test("missing tenant still rejected before the controller (400)", async () => {
    const r = await get(null);
    expect(r.status).toBe(400);
    expect(mockState.queries).toEqual([]);
  });
});

describe.each([["users"], ["tenant"]])("failure in %s lookup", (fail) => {
  test("500 with generic public message; no internal marker/infrastructure/path text", async () => {
    mockState.fail = fail;
    const r = await get();
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ success: false, error: { message: "Failed to retrieve users", code: "INTERNAL_SERVER_ERROR", status: 500 }, correlationId: "cid-1" });
    expect(r.raw).not.toMatch(/ROLE_USERS_INTERNAL_MARKER|secret-host|redis:\/\/|\/srv\/private/);
  });
  test("full internal error still logged server-side", async () => {
    mockState.fail = fail;
    await get();
    expect(logs.some((l) => l.startsWith("error getAllUsers - error details:") && l.includes("ROLE_USERS_INTERNAL_MARKER"))).toBe(true);
  });
});

describe("context logging", () => {
  test("whole req.ctx is not logged; roles/permissions arrays never logged", async () => {
    await get();
    expect(logs.some((l) => l.includes("req.ctx"))).toBe(false);
    expect(logs.some((l) => /ROLE_ARRAY_MARKER|PERMISSION_ARRAY_MARKER/.test(l))).toBe(false);
  });
  test("only approved minimal fields are logged: tenantId, userId, correlationId", async () => {
    await get();
    const line = logs.find((l) => l.startsWith("log getAllUsers - context:"));
    expect(line).toBeDefined();
    expect(JSON.parse(line.slice("log getAllUsers - context: ".length))).toEqual({ tenantId: A, userId: "actor-1", correlationId: "cid-1" });
  });
});

test("route wiring unchanged: GET /users is requireTenant router-wide + user:read + getAllUsers", () => {
  const router = require("../routes/role.routes");
  const wide = router.stack.filter((l) => !l.route).map((l) => l.name);
  expect([wide[0], wide[2]]).toEqual(["authenticate", "requireTenant"]);
  const users = router.stack.find((l) => l.route && l.route.path === "/users" && l.route.methods.get);
  expect(users.route.stack.map((x) => x.name)[0]).toBe("policy:user:read");
  expect(users.route.stack[1].handle).toBe(require("../controllers/role.controller").getAllUsers);
});
