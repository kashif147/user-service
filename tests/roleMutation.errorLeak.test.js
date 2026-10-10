/**
 * Phase 1C-2V — role mutation endpoints no longer turn unrecognised errors into raw public 500s.
 *
 * RoleController.updateRolePermissions / assignRolesToUser / syncRolesForUser mapped recognised handler
 * messages (Invalid…, User/Role(s) not found, already has all) to 400 and RolePrivilegeError to 403, but
 * every other error became AppError.internalServerError(<raw message>) — e.g. infrastructure addresses.
 * Now those fall back to fixed messages; recognised mappings and success responses are unchanged, and the
 * original error is logged server-side.
 *
 * Mounts the REAL routes/role.routes.js + RoleController + response.mw + the app.js final handler (taken
 * verbatim) under NODE_ENV=staging. RoleHandler is a per-test stub with a real-shaped RolePrivilegeError.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");

const A = "68cbf7806080b4621d469d34";
const RID = "a00000000000000000000004";
const UID = "c00000000000000000000002";
const MARK = "ROLE_INTERNAL_MARKER redis://secret-host:6379 /srv/private/role.js";
const mockOutcome = { v: null, calls: [] };

jest.mock("../handlers/role.handler", () => {
  class RolePrivilegeError extends Error {
    constructor(m) { super(m); this.name = "RolePrivilegeError"; this.status = 403; this.code = "ROLE_PRIVILEGE_VIOLATION"; }
  }
  const act = (fn) => async (...args) => {
    mockOutcome.calls.push(fn);
    const o = mockOutcome.v;
    if (o.throwPriv) throw new RolePrivilegeError("Only SU may assign platform or system roles");
    if (o.throwMsg !== undefined) throw new Error(o.throwMsg);
    return o.ret;
  };
  return { RolePrivilegeError, updateRolePermissions: act("update"), assignRolesToUser: act("assign"), syncRolesForUser: act("sync") };
});
jest.mock("../models/user.model", () => ({}));
jest.mock("../models/tenant.model", () => ({}));
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
      req.ctx = { tenantId: A, userId: "actor-1", roles: ["SU"], permissions: [] };
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
let errorLogs;
beforeAll(async () => {
  process.env.NODE_ENV = "staging";
  process.on("unhandledRejection", onUnhandled);
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
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
  mockOutcome.v = null;
  mockOutcome.calls = [];
  unhandled.length = 0;
  errorLogs = [];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation((...a) => errorLogs.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" ")));
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  expect(unhandled).toEqual([]);
  jest.restoreAllMocks();
});

const send = (method, p, body) => new Promise((resolve) => {
  const d = JSON.stringify(body);
  const rq = http.request({ port, path: p, method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(d), "x-correlation-id": "cid-1" }, timeout: 3000 }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, raw: b, body: JSON.parse(b) }));
  });
  rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
  rq.end(d);
});
const errMsg = (r) => (r.body.error ? r.body.error.message : r.body.message);
const noLeak = (r) => expect(r.raw).not.toMatch(/ROLE_INTERNAL_MARKER|secret-host|redis:\/\/|\/srv\/private/);

const UPDATE = ["PUT", `/api/roles/${RID}/permissions`];
const ASSIGN = ["POST", "/api/users/assign-role"];
const BATCH = ["POST", "/api/users/assign-roles-batch"];
const SYNC = ["PUT", "/api/users/sync-roles"];
const ASSIGN_RET = { user: { _id: UID, roles: [RID] }, assignedRoles: 1, alreadyAssignedRoles: 0, assignedRoleIds: [RID], alreadyAssignedRoleIds: [] };

describe("updateRolePermissions (PUT /api/roles/:id/permissions)", () => {
  const body = { permissions: ["lookup:read"] };
  test("success unchanged", async () => {
    mockOutcome.v = { ret: { _id: RID, permissions: ["lookup:read"] } };
    const r = await send(...UPDATE, body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "success", data: { _id: RID, permissions: ["lookup:read"] } });
  });
  test.each([
    ["handler returns null -> notFoundRecord", { ret: null }, body, 200, "Role not found"],
    ["permissions not an array", { ret: {} }, { permissions: "x" }, 400, "permissions must be an array (can be empty)"],
    ["privilege violation", { throwPriv: true }, body, 403, "Only SU may assign platform or system roles"],
    ["Invalid roleId", { throwMsg: "Error updating role permissions: Invalid roleId format: x." }, body, 400, "Invalid roleId format: x."],
    ["Role not found", { throwMsg: "Error updating role permissions: Role not found" }, body, 400, "Role not found"],
  ])("recognised: %s keeps its status/message", async (_l, outcome, b, status, message) => {
    mockOutcome.v = outcome;
    const r = await send(...UPDATE, b);
    expect(r.status).toBe(status);
    expect(errMsg(r)).toBe(message);
  });
  test.each([[`Error updating role permissions: ${MARK}`], [MARK]])("unexpected error (%#) -> generic 500, no leak, still logged", async (m) => {
    mockOutcome.v = { throwMsg: m };
    const r = await send(...UPDATE, body);
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({ message: "Failed to update role permissions", code: "INTERNAL_SERVER_ERROR", status: 500 });
    noLeak(r);
    expect(errorLogs.some((l) => l.startsWith("[updateRolePermissions] unexpected error:") && l.includes("ROLE_INTERNAL_MARKER"))).toBe(true);
  });
});

describe("assignRolesToUser (POST /api/users/assign-role and /assign-roles-batch)", () => {
  const body = { userId: UID, roleIds: [RID] };
  test.each([[ASSIGN], [BATCH]])("success unchanged (%#)", async (route) => {
    mockOutcome.v = { ret: ASSIGN_RET };
    const r = await send(...route, body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: "success",
      message: "Roles assigned to user successfully",
      data: { user: ASSIGN_RET.user, summary: { assignedRoles: 1, alreadyAssignedRoles: 0, assignedRoleIds: [RID], alreadyAssignedRoleIds: [] } },
    });
  });
  test.each([
    ["missing userId", { ret: ASSIGN_RET }, { roleIds: [RID] }, 400, "userId is required", false],
    ["empty roleIds", { ret: ASSIGN_RET }, { userId: UID, roleIds: [] }, 400, "roleIds must be a non-empty array", false],
    ["privilege violation (protected role)", { throwPriv: true }, body, 403, "Only SU may assign platform or system roles", true],
    ["User not found (incl. cross-tenant)", { throwMsg: "Error assigning roles to user: User not found" }, body, 400, "User not found", true],
    ["Roles not found (incl. cross-tenant)", { throwMsg: `Error assigning roles to user: Roles not found: ${RID}` }, body, 400, `Roles not found: ${RID}`, true],
    ["duplicate", { throwMsg: "Error assigning roles to user: User already has all the specified roles" }, body, 400, "User already has all the specified roles", true],
    ["Invalid userId", { throwMsg: "Error assigning roles to user: Invalid userId format: x." }, body, 400, "Invalid userId format: x.", true],
  ])("recognised: %s keeps its status/message", async (_l, outcome, b, status, message, handlerCalled) => {
    mockOutcome.v = outcome;
    const r = await send(...ASSIGN, b);
    expect(r.status).toBe(status);
    expect(errMsg(r)).toBe(message);
    expect(mockOutcome.calls.length > 0).toBe(handlerCalled);
  });
  test.each([[`Error assigning roles to user: ${MARK}`], [MARK]])("unexpected error (%#) -> generic 500, no leak, still logged", async (m) => {
    mockOutcome.v = { throwMsg: m };
    const r = await send(...ASSIGN, body);
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({ message: "Failed to assign roles to user", code: "INTERNAL_SERVER_ERROR", status: 500 });
    noLeak(r);
    expect(errorLogs.some((l) => l.startsWith("[assignRolesToUser]") && l.includes("ROLE_INTERNAL_MARKER"))).toBe(true);
  });
});

describe("syncRolesForUser (PUT /api/users/sync-roles)", () => {
  const body = { userId: UID, roleIds: [RID] };
  test("success unchanged", async () => {
    mockOutcome.v = { ret: { user: { _id: UID, roles: [RID] } } };
    const r = await send(...SYNC, body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "success", message: "User roles updated successfully", data: { user: { _id: UID, roles: [RID] } } });
  });
  test.each([
    ["missing userId", { ret: {} }, { roleIds: [RID] }, 400, "userId is required"],
    ["roleIds not an array", { ret: {} }, { userId: UID, roleIds: "x" }, 400, "roleIds must be an array"],
    ["privilege violation", { throwPriv: true }, body, 403, "Only SU may assign platform or system roles"],
    ["User not found", { throwMsg: "Error syncing roles for user: User not found" }, body, 400, "User not found"],
    ["Roles not found", { throwMsg: `Error syncing roles for user: Roles not found: ${RID}` }, body, 400, `Roles not found: ${RID}`],
    ["Invalid roleId", { throwMsg: "Error syncing roles for user: Invalid roleId format: x." }, body, 400, "Invalid roleId format: x."],
  ])("recognised: %s keeps its status/message", async (_l, outcome, b, status, message) => {
    mockOutcome.v = outcome;
    const r = await send(...SYNC, b);
    expect(r.status).toBe(status);
    expect(errMsg(r)).toBe(message);
  });
  test.each([[`Error syncing roles for user: ${MARK}`], [MARK]])("unexpected error (%#) -> generic 500, no leak, still logged", async (m) => {
    mockOutcome.v = { throwMsg: m };
    const r = await send(...SYNC, body);
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({ message: "Failed to sync user roles", code: "INTERNAL_SERVER_ERROR", status: 500 });
    noLeak(r);
    expect(errorLogs.some((l) => l.startsWith("[syncRolesForUser] unexpected error:") && l.includes("ROLE_INTERNAL_MARKER"))).toBe(true);
  });
});

test("route wiring unchanged: role:admin gates the three endpoints", () => {
  const router = require("../routes/role.routes");
  const ctl = require("../controllers/role.controller");
  const find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]).route.stack;
  for (const [m, p, fn] of [["put", "/roles/:id/permissions", "updateRolePermissions"], ["post", "/users/assign-role", "assignRolesToUser"], ["post", "/users/assign-roles-batch", "assignRolesToUser"], ["put", "/users/sync-roles", "syncRolesForUser"]]) {
    const chain = find(m, p);
    expect(chain.map((x) => x.name)[0]).toBe("policy:role:admin");
    expect(chain[1].handle).toBe(ctl[fn]);
  }
});
