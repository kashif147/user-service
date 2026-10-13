/**
 * Phase 2a: every authentication-connection write path enforces the provisioning rules
 * (helpers/connectionDefaultRole.js) - POST/PUT /tenants/:id/auth-connections, POST /tenants and
 * PUT /tenants/:id with a full authenticationConnections array (the Tenant Management form) - and
 * the role picker endpoint lists the eligible roles of the EDITED organisation, not the caller's.
 *
 * Mounts the REAL routes/tenant.routes.js + tenant.controller + tenant.handler +
 * connectionDefaultRole over HTTP (harness as tenant.crashPaths.test.js); models are in-memory.
 */
const http = require("http");
const express = require("express");

const A = "68cbf7806080b4621d469d34"; // MULTIAUTH
const B = "6acd6119b28a863c61361ae0"; // DEVTENANTB
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const CONN_E = "f00000000000000000000001";
const CONN_B = "f00000000000000000000002";
const rid = (n) => `5${String(n).padStart(23, "0")}`;
const REO_A = rid(1);
const NONMEMBER_A = rid(2);
const REO_B = rid(3);
const INACTIVE_A = rid(4);
const SU_A = rid(5);

const mockState = { tenants: {}, writes: [], created: [] };
const mockRoles = [
  { _id: rid(1), tenantId: A, code: "REO", name: "Read Only", category: "CRM", isActive: true, permissions: ["profile:read"] },
  { _id: rid(2), tenantId: A, code: "NON-MEMBER", name: "Non Member", category: "PORTAL", isActive: true, permissions: [] },
  { _id: rid(3), tenantId: B, code: "REO", name: "Read Only", category: "CRM", isActive: true, permissions: [] },
  { _id: rid(4), tenantId: A, code: "OLD", name: "Old", category: "CRM", isActive: false, permissions: [] },
  { _id: rid(5), tenantId: A, code: "SU", name: "Super User", category: "SYSTEM", isActive: true, isSystemRole: true, permissions: ["*"] },
];
const mockConn = (id, o) => ({ _id: id, id, issuerUrl: "https://login.microsoftonline.com/d/v2.0", directoryId: `dir-${id}`, audience: "aud", isActive: true, ...o });
const mockReset = () => {
  mockState.writes = [];
  mockState.created = [];
  mockState.tenants = {
    [A]: {
      _id: A,
      code: "MULTIAUTH",
      authenticationConnections: [
        mockConn(CONN_E, { connectionType: ENTRA }), // unset
        mockConn(CONN_B, { connectionType: B2C, autoProvisionUsers: true }), // legacy automatic, no role yet
      ],
    },
    [B]: { _id: B, code: "DEVTENANTB", authenticationConnections: [] },
  };
};
const mockMatchRole = (r, q) =>
  Object.entries(q).every(([k, v]) => (v && typeof v === "object" && "$in" in v ? v.$in.map(String).includes(String(r[k])) : String(r[k]) === String(v)));
const mockDoc = (t) => {
  const conns = t.authenticationConnections;
  conns.id = (cid) => conns.find((c) => c.id === String(cid)) || null;
  t.save = async function () {
    mockState.writes.push(`save:${t._id}`);
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
    const id = q && q._id ? String(q._id) : null;
    return id && mockState.tenants[id] ? mockDoc(mockState.tenants[id]) : null;
  }),
  findOneAndUpdate: async (q, u) => {
    const t = mockState.tenants[String(q._id)];
    if (!t) return null;
    mockState.writes.push(`update:${t._id}`);
    Object.assign(t, u.$set || u);
    return t;
  },
  create: async (p) => {
    mockState.created.push(p);
    return { ...p, _id: { toString: () => "7ddddddddddddddddddddddd" } };
  },
}));
jest.mock("../models/role.model", () => ({
  findOne: (q) => {
    const r = mockRoles.find((x) => mockMatchRole(x, q));
    return { select() { return this; }, lean: async () => (r ? { ...r } : null) };
  },
  find: (q) => {
    const rows = mockRoles.filter((x) => mockMatchRole(x, q));
    const c = { select: () => c, sort: () => c, lean: async () => rows.map((r) => ({ ...r })), then: (a, b) => Promise.resolve(rows.length ? rows : [{}]).then(a, b) };
    return c;
  },
  countDocuments: async () => 0,
}));
jest.mock("../models/permission.model", () => ({ find: () => ({ select: () => ({ lean: async () => [] }) }) }));
jest.mock("../models/user.model", () => ({ countDocuments: async () => 0 }));
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
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function call(method, path, { body, roles = ["SU"], tenant = A, headers = {} } = {}) {
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
const P = (t, c) => `/api/tenants/${t}/auth-connections${c ? `/${c}` : ""}`;
const conns = (t) => mockState.tenants[t].authenticationConnections;
const newConn = (o) => ({ connectionType: ENTRA, issuerUrl: "https://login.microsoftonline.com/n/v2.0", directoryId: "dir-new", audience: "aud", ...o });

describe("POST /tenants/:id/auth-connections", () => {
  test("automatic without a default role -> 400, nothing saved", async () => {
    const r = await call("POST", P(A), { body: newConn({ autoProvisionUsers: true }) });
    expect(r.status).toBe(400);
    expect(errMsg(r)).toBe("Automatic user provisioning requires a default role");
    expect(mockState.writes).toEqual([]);
  });
  test("cross-organisation / inactive / SU default role -> 400, nothing saved", async () => {
    for (const [roleId, msg] of [
      [REO_B, "Default role was not found in this organisation"],
      [INACTIVE_A, "Default role is inactive"],
      [SU_A, "Privileged or system roles cannot be a default role"],
    ]) {
      const r = await call("POST", P(A), { body: newConn({ autoProvisionUsers: true, defaultRoleId: roleId }) });
      expect(r.status).toBe(400);
      expect(errMsg(r)).toBe(msg);
    }
    expect(mockState.writes).toEqual([]);
  });
  test("valid default role -> saved; unknown fields are not stored", async () => {
    const r = await call("POST", P(A), { body: newConn({ autoProvisionUsers: true, defaultRoleId: REO_A, isSystem: true, _id: "x" }) });
    expect(r.status).toBe(200);
    const added = conns(A)[2];
    expect(added).toMatchObject({ autoProvisionUsers: true, defaultRoleId: REO_A });
    expect(added.isSystem).toBeUndefined();
    expect(added._id).toBeUndefined();
  });
});

describe("PUT /tenants/:id/auth-connections/:connectionId", () => {
  test("enabling automatic provisioning without a role -> 400; with a valid role -> saved", async () => {
    let r = await call("PUT", P(A, CONN_E), { body: { autoProvisionUsers: true } });
    expect(r.status).toBe(400);
    expect(conns(A)[0].autoProvisionUsers).toBeUndefined();
    r = await call("PUT", P(A, CONN_E), { body: { autoProvisionUsers: true, defaultRoleId: REO_A } });
    expect(r.status).toBe(200);
    expect(conns(A)[0]).toMatchObject({ autoProvisionUsers: true, defaultRoleId: REO_A });
  });
  test("setting only defaultRoleId on a legacy automatic connection (the post-deploy DEV step)", async () => {
    let r = await call("PUT", P(A, CONN_B), { body: { defaultRoleId: REO_A } });
    expect(r.status).toBe(400); // CRM role on a B2C connection
    r = await call("PUT", P(A, CONN_B), { body: { defaultRoleId: NONMEMBER_A } });
    expect(r.status).toBe(200);
    expect(conns(A)[1]).toMatchObject({ autoProvisionUsers: true, defaultRoleId: NONMEMBER_A });
  });
  test("pre-authorised flag change on a legacy automatic connection is fine without a role", async () => {
    const r = await call("PUT", P(A, CONN_B), { body: { autoProvisionUsers: false } });
    expect(r.status).toBe(200);
    expect(conns(A)[1].autoProvisionUsers).toBe(false);
  });
  test("fields outside the connection whitelist are ignored", async () => {
    const r = await call("PUT", P(A, CONN_E), { body: { audience: "aud2", tenantId: B, createdAt: "1999-01-01" } });
    expect(r.status).toBe(200);
    expect(conns(A)[0].audience).toBe("aud2");
    expect(conns(A)[0].tenantId).toBeUndefined();
    expect(conns(A)[0].createdAt).toBeUndefined();
  });
});

describe("PUT /tenants/:id with a full authenticationConnections array (Tenant Management form)", () => {
  const formArray = () => conns(A).map((c) => ({ ...c }));
  test("cannot bypass the rules: enabling automatic without a role -> 400, nothing written", async () => {
    const body = formArray();
    body[0].autoProvisionUsers = true;
    const r = await call("PUT", `/api/tenants/${A}`, { body: { authenticationConnections: body } });
    expect(r.status).toBe(400);
    expect(errMsg(r)).toBe("Automatic user provisioning requires a default role");
    expect(mockState.writes).toEqual([]);
  });
  test("cannot bypass the rules: SU / cross-organisation role -> 400", async () => {
    for (const roleId of [SU_A, REO_B]) {
      const body = formArray();
      Object.assign(body[0], { autoProvisionUsers: true, defaultRoleId: roleId });
      const r = await call("PUT", `/api/tenants/${A}`, { body: { authenticationConnections: body } });
      expect(r.status).toBe(400);
    }
    expect(mockState.writes).toEqual([]);
  });
  test("a valid change is written; untouched legacy connections are kept as they are", async () => {
    const body = formArray();
    Object.assign(body[0], { autoProvisionUsers: true, defaultRoleId: REO_A });
    const r = await call("PUT", `/api/tenants/${A}`, { body: { authenticationConnections: body } });
    expect(r.status).toBe(200);
    expect(mockState.writes).toEqual([`update:${A}`]);
    expect(conns(A)[0]).toMatchObject({ _id: CONN_E, autoProvisionUsers: true, defaultRoleId: REO_A });
    expect(conns(A)[1]).toMatchObject({ _id: CONN_B, autoProvisionUsers: true });
  });
  test("a tenant update without connections is unaffected", async () => {
    const r = await call("PUT", `/api/tenants/${A}`, { body: { name: "Renamed" } });
    expect(r.status).toBe(200);
    expect(conns(A)).toHaveLength(2);
  });
});

describe("POST /tenants with connections", () => {
  const tenantBody = (connections) => ({ name: "New Org", code: "NEWORG", domain: "new.example", authenticationConnections: connections });
  test("an automatic connection cannot be created with the organisation (its roles do not exist yet) -> 400", async () => {
    for (const c of [newConn({ autoProvisionUsers: true }), newConn({ autoProvisionUsers: true, defaultRoleId: REO_A }), newConn({ defaultRoleId: REO_A })]) {
      const r = await call("POST", "/api/tenants", { body: tenantBody([c]) });
      expect(r.status).toBe(400);
    }
    expect(mockState.created).toEqual([]);
  });
  test("pre-authorised connections are created; unknown fields dropped; bad flag -> 400", async () => {
    let r = await call("POST", "/api/tenants", { body: tenantBody([newConn({ autoProvisionUsers: "yes" })]) });
    expect(r.status).toBe(400);
    r = await call("POST", "/api/tenants", { body: tenantBody([newConn({ autoProvisionUsers: false, evil: 1 })]) });
    expect(r.status).toBe(201);
    expect(mockState.created[0].authenticationConnections).toEqual([newConn({ autoProvisionUsers: false })]);
  });
});

describe("GET /tenants/:id/auth-connections/default-role-options", () => {
  const opts = (t, type, o) => call("GET", `${P(t)}/default-role-options?connectionType=${encodeURIComponent(type)}`, o);
  test("SU editing another organisation gets THAT organisation's eligible roles", async () => {
    const r = await opts(B, ENTRA, { tenant: A, roles: ["SU"] });
    expect(r.status).toBe(200);
    expect(r.body.data.map((x) => x._id)).toEqual([REO_B]);
  });
  test("only active, non-privileged roles of the matching type", async () => {
    expect((await opts(A, ENTRA)).body.data.map((x) => x.code)).toEqual(["REO"]);
    expect((await opts(A, B2C)).body.data.map((x) => x.code)).toEqual(["NON-MEMBER"]);
  });
  test("unknown connection type -> 400; a non-SU caller cannot read another organisation's roles", async () => {
    expect((await opts(A, "SAML")).status).toBe(400);
    const r = await opts(B, ENTRA, { tenant: A, roles: ["ASU"] });
    expect(r.status).toBe(403);
  });
});
