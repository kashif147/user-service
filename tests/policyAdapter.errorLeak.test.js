/**
 * Phase 1C-2T — helpers/policyAdapter.js no longer returns raw exception text to clients.
 *
 * The adapter's middleware guards ~158 routes. Its catch block called sendErrorResponse, which put
 * error.message (e.g. infrastructure addresses, file paths) into the 500 body. It now returns a fixed
 * public message; status 500, reason POLICY_SERVICE_ERROR, the field set and the server-side
 * console.error logging are unchanged. PERMIT / DENY / 401 paths are untouched.
 *
 * Uses the REAL policyAdapter middleware with a stubbed policyEvaluationService.
 */
const http = require("http");
const express = require("express");

const MARK = "POLICY_INTERNAL_MARKER redis://secret-host:6379 /srv/private/policy.js";
const mockPdp = { impl: null };
jest.mock("../services/policyEvaluationService", () => ({
  evaluatePolicy: (...a) => mockPdp.impl(...a),
  cache: {},
}));

const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

const USER = { id: "u1", tenantId: "t1", roles: ["MO"], permissions: ["lookup:read"] };
let server;
let port;
const unhandled = [];
const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
let errorLogs;
const ORIGINAL_BYPASS = process.env.AUTH_BYPASS_ENABLED;

beforeAll(async () => {
  process.env.AUTH_BYPASS_ENABLED = "false";
  process.on("unhandledRejection", onUnhandled);
  const app = express();
  app.use(express.json());
  app.get("/x", defaultPolicyAdapter.middleware("lookup", "read"), (req, res) => res.status(200).json({ reached: true, userId: req.user && req.user.id }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => {
  process.env.AUTH_BYPASS_ENABLED = ORIGINAL_BYPASS;
  process.off("unhandledRejection", onUnhandled);
  return new Promise((r) => server.close(r));
});
beforeEach(() => {
  unhandled.length = 0;
  errorLogs = [];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation((...a) => errorLogs.push(a.map((x) => (x && x.stack) || String(x)).join(" ")));
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  expect(unhandled).toEqual([]);
  jest.restoreAllMocks();
});

const get = (headers = { authorization: "Bearer aaa.bbb.ccc", "x-correlation-id": "cid-1" }) => new Promise((resolve) => {
  const rq = http.get({ port, path: "/x", headers, timeout: 3000 }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, raw: b, body: b ? JSON.parse(b) : null }));
  });
  rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
});
const noLeak = (r) => expect(r.raw).not.toMatch(/POLICY_INTERNAL_MARKER|secret-host|redis:\/\/|\/srv\/private/);

test("PERMIT unchanged: handler reached with the PDP user attached", async () => {
  mockPdp.impl = async () => ({ decision: "PERMIT", reason: "POLICY_SATISFIED", user: USER });
  const r = await get();
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ reached: true, userId: "u1" });
});

test.each(["MISSING_PERMISSION", "INVALID_USER_TYPE", "INSUFFICIENT_RESOURCE_PERMISSION", "MISSING_TENANT_CONTEXT", "UNKNOWN_RESOURCE", "TENANT_SCOPE_VIOLATION"])(
  "DENY %s unchanged: 403 with the same reason code and body shape",
  async (reason) => {
    mockPdp.impl = async () => ({ decision: "DENY", reason, user: USER });
    const r = await get();
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      authorized: false, reason, requiredRoles: [], requiredPermissions: [],
      userRoles: ["MO"], userPermissions: ["lookup:read"], policyVersion: "1.0.0", correlationId: "cid-1",
    });
  }
);

test("missing token unchanged: 401 MISSING_TOKEN, PDP not called", async () => {
  mockPdp.impl = jest.fn();
  const r = await get({});
  expect(r.status).toBe(401);
  expect(r.body.reason).toBe("MISSING_TOKEN");
  expect(mockPdp.impl).not.toHaveBeenCalled();
});

test("PDP result carrying an internal error string -> 403 with reason only (unchanged, never echoed)", async () => {
  mockPdp.impl = async () => ({ decision: "DENY", reason: "RESOURCE_EVALUATION_ERROR", error: MARK, user: USER });
  const r = await get();
  expect(r.status).toBe(403);
  expect(r.body.reason).toBe("RESOURCE_EVALUATION_ERROR");
  noLeak(r);
});

test("PDP throws -> 403 EVALUATION_ERROR (unchanged); exception text not in response, still logged", async () => {
  mockPdp.impl = async () => { throw new Error(MARK); };
  const r = await get();
  expect(r.status).toBe(403);
  expect(r.body.reason).toBe("EVALUATION_ERROR");
  noLeak(r);
  expect(errorLogs.some((l) => l.includes("POLICY_INTERNAL_MARKER"))).toBe(true);
});

test("unexpected exception inside the middleware -> 500 POLICY_SERVICE_ERROR with a generic message (was raw error.message)", async () => {
  mockPdp.impl = async () => {
    const u = { id: "u1" };
    Object.defineProperty(u, "roles", { get() { throw new Error(MARK); } }); // throws while the 403 body is built
    return { decision: "DENY", reason: "MISSING_PERMISSION", user: u };
  };
  const r = await get();
  expect(r.status).toBe(500);
  expect(r.body).toEqual({
    authorized: false, reason: "POLICY_SERVICE_ERROR", error: "Policy evaluation failed",
    requiredRoles: [], requiredPermissions: [], userRoles: [], userPermissions: [], policyVersion: "1.0.0", correlationId: "cid-1",
  });
  noLeak(r);
  expect(errorLogs.some((l) => l.includes("POLICY_INTERNAL_MARKER"))).toBe(true); // full error stays server-side
});

test("decision equivalence: response status depends only on the PDP decision", async () => {
  const seen = [];
  for (const decision of ["PERMIT", "DENY", "NOT_APPLICABLE", undefined]) {
    for (const reason of ["POLICY_SATISFIED", "MISSING_PERMISSION", "SUPER_USER_BYPASS", undefined]) {
      mockPdp.impl = async () => ({ decision, reason, user: USER });
      const r = await get();
      seen.push([decision, r.status]);
      expect(r.status).toBe(decision === "PERMIT" ? 200 : 403);
    }
  }
  expect(seen).toHaveLength(16);
});
