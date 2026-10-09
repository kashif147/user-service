/**
 * Phase 1C-2Q — tenant.controller.js no longer calls res.fail().
 *
 * middlewares/response.mw.js does not define res.fail. Six tenant-management error paths
 * (stats, status, and add/update/remove/list authentication connections) called it from async
 * Express 4 handlers: the TypeError became an unhandled rejection, which ends the Node 22 process.
 * They now use response.mw.js helpers with the tenant API's existing conventions:
 * not found -> 404, bad input -> 400, otherwise a generic 500 (no internal text).
 *
 * Mounts the REAL routes/tenant.routes.js + tenant.controller + tenant.handler + response.mw with the
 * REAL requireTenant / requireTenantPathAccess over HTTP. authenticate is a stub (x-test-* headers ->
 * req.ctx); the policy adapter is a pass-through; Tenant/User/Role models are fixture-backed mocks.
 */
const http = require("http");
const express = require("express");

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const C = "cccccccccccccccccccccccc"; // no such tenant
const CONN = "f00000000000000000000001";
const CONN2 = "f00000000000000000000002";
const NOCONN = "f0000000000000000000dead";

const mockState = { fail: null, mutations: [], tenants: {} };
const mockConn = (id, dir) => ({ _id: id, id, directoryId: dir, isActive: true, connectionType: "AZURE_B2C" });
const mockReset = () => {
  mockState.fail = null;
  mockState.mutations = [];
  mockState.tenants = {
    [A]: { _id: A, status: "ACTIVE", authenticationConnections: [mockConn(CONN, "dir-1"), mockConn(CONN2, "dir-2")] },
    [B]: { _id: B, status: "ACTIVE", authenticationConnections: [] },
  };
};
const mockBoom = () => new Error("mongo down: secret-host:27017");
const mockMatch = (q) => {
  const id = q && q.$or ? q.$or[0]._id : null;
  return id && mockState.tenants[id] ? mockState.tenants[id] : null;
};
const mockDoc = (t) => {
  const conns = t.authenticationConnections;
  conns.id = (cid) => conns.find((c) => c.id === String(cid)) || null;
  t.save = async function () {
    if (mockState.fail === "save") throw mockBoom();
    mockState.mutations.push(`save:${t._id}`);
    return this;
  };
  return t;
};
const mockLazy = (fn) => {
  const o = { select: () => o, lean: () => o, then: (a, b) => Promise.resolve().then(fn).then(a, b) };
  return o;
};

jest.mock("../models/tenant.model", () => ({
  findOne: (q) => mockLazy(() => {
    if (mockState.fail === "find") throw mockBoom();
    const t = mockMatch(q);
    return t ? mockDoc(t) : null;
  }),
  findOneAndUpdate: async (q, u) => {
    if (mockState.fail === "update") throw mockBoom();
    const t = mockMatch(q);
    if (!t) return null;
    Object.assign(t, u.$set || u);
    mockState.mutations.push(`update:${t._id}:${t.status}`);
    return t;
  },
}));
jest.mock("../models/user.model", () => ({
  countDocuments: async () => { if (mockState.fail === "count") throw mockBoom(); return 3; },
}));
jest.mock("../models/role.model", () => ({ countDocuments: async () => 2 }));
jest.mock("../services/azure.blob.service", () => ({}));
jest.mock("../middlewares/upload.mw", () => ({ brandingAssetUploadMw: (req, res, next) => next() }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: (r) => !!r && r.includes("SU"), isAssistantSuperUser: () => false, isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1, hasMinimumRole: () => false,
}));
jest.mock("../helpers/policyAdapter.js", () => ({ defaultPolicyAdapter: { middleware: () => (req, res, next) => next() } }));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    tenantContextWarn: (req, res, next) => next(),
    authenticate: (req, res, next) => {
      const t = req.headers["x-test-tenant"];
      if (t || req.headers["x-test-roles"]) {
        req.ctx = { tenantId: t, userId: "c00000000000000000000009", roles: JSON.parse(req.headers["x-test-roles"] || "[]") };
      }
      next();
    },
  };
});

let server;
let port;
const unhandled = [];
const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
beforeAll(async () => {
  process.on("unhandledRejection", onUnhandled);
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/tenant.routes"));
  app.use((req, res) => res.status(404).json({ notFound: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: { message: err.message } }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  return new Promise((r) => server.close(r));
});
beforeEach(() => {
  mockReset();
  unhandled.length = 0;
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  expect(unhandled).toEqual([]); // an unhandled rejection would end the Node 22 process
  jest.restoreAllMocks();
});

function call(method, path, { body, roles = ["MO"], tenant = A, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { "content-type": "application/json", "x-test-roles": JSON.stringify(roles), ...headers };
    if (tenant) h["x-test-tenant"] = tenant;
    if (data) h["content-length"] = Buffer.byteLength(data);
    const rq = http.request({ port, path, method, headers: h, timeout: 3000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = b ? JSON.parse(b) : null; } catch (e) { parsed = { raw: b }; }
        resolve({ status: res.statusCode, body: parsed, raw: b });
      });
    });
    rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
    if (data) rq.write(data);
    rq.end();
  });
}
const errMsg = (r) => r.body && r.body.error && r.body.error.message;
const expect500 = (r, message) => {
  expect(r.status).toBe(500);
  expect(errMsg(r)).toBe(message);
  expect(r.raw).not.toMatch(/secret-host|mongo down/); // no internal text
};

describe("GET /api/tenants/:id/stats", () => {
  test("success unchanged", async () => {
    const r = await call("GET", `/api/tenants/${A}/stats`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "success", data: { totalUsers: 3, activeUsers: 3, totalRoles: 2, inactiveUsers: 0 } });
  });
  test("unexpected failure -> generic 500 (was a process crash)", async () => {
    mockState.fail = "count";
    expect500(await call("GET", `/api/tenants/${A}/stats`), "Failed to retrieve tenant stats");
  });
});

describe("PUT /api/tenants/:id/status", () => {
  test("success unchanged", async () => {
    const r = await call("PUT", `/api/tenants/${A}/status`, { body: { status: "SUSPENDED" } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("success");
    expect(mockState.mutations).toEqual([`update:${A}:SUSPENDED`]);
  });
  test("invalid status -> 400, nothing written", async () => {
    const r = await call("PUT", `/api/tenants/${A}/status`, { body: { status: "BOGUS" } });
    expect(r.status).toBe(400);
    expect(errMsg(r)).toBe("Invalid status");
    expect(mockState.mutations).toEqual([]);
  });
  test("tenant not found (SU) -> 404", async () => {
    const r = await call("PUT", `/api/tenants/${C}/status`, { body: { status: "ACTIVE" }, roles: ["SU"] });
    expect(r.status).toBe(404);
    expect(errMsg(r)).toBe("Tenant not found");
  });
  test("unexpected failure -> generic 500", async () => {
    mockState.fail = "update";
    expect500(await call("PUT", `/api/tenants/${A}/status`, { body: { status: "ACTIVE" } }), "Failed to update tenant status");
    expect(mockState.mutations).toEqual([]);
  });
});

describe("authentication connections", () => {
  const P = (id, conn) => `/api/tenants/${id}/auth-connections${conn ? `/${conn}` : ""}`;
  test("add: success unchanged", async () => {
    const r = await call("POST", P(A), { body: { connectionType: "AZURE_B2C", directoryId: "new-dir", issuerUrl: "https://x", audience: "aud" } });
    expect(r.status).toBe(200);
    expect(mockState.mutations).toEqual([`save:${A}`]);
  });
  test("add: duplicate Directory ID -> 400, nothing saved", async () => {
    const r = await call("POST", P(A), { body: { directoryId: "dir-1" } });
    expect(r.status).toBe(400);
    expect(errMsg(r)).toBe("Authentication connection with this Directory ID already exists");
    expect(mockState.mutations).toEqual([]);
  });
  test("add: tenant not found (SU) -> 404; unexpected failure -> 500", async () => {
    const nf = await call("POST", P(C), { body: { directoryId: "x" }, roles: ["SU"] });
    expect(nf.status).toBe(404);
    mockState.fail = "save";
    expect500(await call("POST", P(A), { body: { directoryId: "new-dir" } }), "Failed to add authentication connection");
    expect(mockState.mutations).toEqual([]);
  });
  test("update: success unchanged", async () => {
    const r = await call("PUT", P(A, CONN), { body: { audience: "aud2" } });
    expect(r.status).toBe(200);
    expect(mockState.mutations).toEqual([`save:${A}`]);
  });
  test("update: connection not found -> 404; duplicate -> 400; tenant not found (SU) -> 404; none saved", async () => {
    const nc = await call("PUT", P(A, NOCONN), { body: { audience: "aud2" } });
    expect(nc.status).toBe(404);
    expect(errMsg(nc)).toBe("Authentication connection not found");
    const dup = await call("PUT", P(A, CONN), { body: { directoryId: "dir-2" } });
    expect(dup.status).toBe(400);
    const nt = await call("PUT", P(C, CONN), { body: {}, roles: ["SU"] });
    expect(nt.status).toBe(404);
    expect(errMsg(nt)).toBe("Tenant not found");
    expect(mockState.mutations).toEqual([]);
  });
  test("update: unexpected failure -> generic 500", async () => {
    mockState.fail = "save";
    expect500(await call("PUT", P(A, CONN), { body: { audience: "aud2" } }), "Failed to update authentication connection");
  });
  test("remove: success unchanged; not found -> 404; failure -> 500", async () => {
    const ok = await call("DELETE", P(A, CONN));
    expect(ok.status).toBe(200);
    expect(mockState.mutations).toEqual([`save:${A}`]);
    mockReset();
    const nc = await call("DELETE", P(A, NOCONN));
    expect(nc.status).toBe(404);
    expect(mockState.mutations).toEqual([]);
    mockState.fail = "save";
    expect500(await call("DELETE", P(A, CONN)), "Failed to remove authentication connection");
  });
  test("list: success unchanged; tenant not found (SU) -> 404; failure -> 500", async () => {
    const ok = await call("GET", P(A));
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((c) => c.directoryId)).toEqual(["dir-1", "dir-2"]);
    const nf = await call("GET", P(C), { roles: ["SU"] });
    expect(nf.status).toBe(404);
    mockState.fail = "find";
    expect500(await call("GET", P(A)), "Failed to retrieve authentication connections");
  });
});

describe("tenant guards unchanged", () => {
  test("non-SU cannot reach another tenant (403 from requireTenantPathAccess), nothing written", async () => {
    for (const [m, p, body] of [
      ["PUT", `/api/tenants/${B}/status`, { status: "SUSPENDED" }],
      ["POST", `/api/tenants/${B}/auth-connections`, { directoryId: "evil" }],
      ["GET", `/api/tenants/${B}/stats`, undefined],
    ]) {
      const r = await call(m, p, { body });
      expect(r.status).toBe(403);
    }
    expect(mockState.mutations).toEqual([]);
  });
  test("missing tenant fails closed (400), nothing written", async () => {
    const r = await call("PUT", `/api/tenants/${A}/status`, { body: { status: "ACTIVE" }, tenant: null });
    expect(r.status).toBe(400);
    expect(mockState.mutations).toEqual([]);
  });
  test("tenant spoof via body/query/header cannot redirect the write", async () => {
    const r = await call("PUT", `/api/tenants/${A}/status?tenantId=${B}`, { body: { status: "INACTIVE", tenantId: B }, headers: { "x-tenant-id": B } });
    expect(r.status).toBe(200);
    expect(mockState.mutations).toEqual([`update:${A}:INACTIVE`]);
    expect(mockState.tenants[B].status).toBe("ACTIVE");
  });
});

test("tenant.controller.js has no executable res.fail()", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "tenant.controller.js"), "utf8");
  expect(src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")).not.toMatch(/res\.fail\(/);
});
