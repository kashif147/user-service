/**
 * Phase 3B (stages 1-2): additive authentication-connection schema and explicit appRef.
 *
 *  - appRef / directoryOwnership are admin-writable and validated (registered application of the
 *    connection's provider; ownership values per provider); connectedAt / connectedBy /
 *    lastTestedAt / lastTestResult are server-managed - never taken from a request, always carried
 *    over when a connection is saved;
 *  - the Tenant Management full-array save no longer drops fields an older client does not send;
 *  - issuerUrl / audience are optional (issuerUrl still validated when supplied); Entra directory
 *    ids must be GUIDs on new/changed connections, untouched ones are grandfathered;
 *  - every tenant / connection response goes through one allow-list (helpers/authConnectionView.js);
 *  - resolveConnectionAuthConfig uses an explicit appRef, else the compatibility default (logged).
 *
 * Mounts the REAL routes/tenant.routes.js + tenant.controller + tenant.handler +
 * connectionDefaultRole over HTTP (harness as phase2.connectionWritePaths.test.js); models are in
 * memory. New modules are required inside the tests so each test fails on its own on older code.
 */
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");

const A = "68cbf7806080b4621d469d34";
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const CONN_E = "f00000000000000000000001";
const CONN_B = "f00000000000000000000002";
const HOME_DIR = process.env.AZURE_AD_TENANT_ID; // tests/setupEntraEnv.js
const OTHER_GUID = "22222222-2222-4222-8222-222222222222";
const CONNECTED_AT = "2026-10-01T10:00:00.000Z";
const TESTED_AT = "2026-10-02T11:00:00.000Z";
const SECRET = process.env.AZURE_AD_CLIENT_SECRET;

const mockState = { tenants: {}, writes: [] };
const mockStoredEntra = (o = {}) => ({
  _id: CONN_E,
  id: CONN_E,
  connectionType: ENTRA,
  directoryId: HOME_DIR,
  issuerUrl: "https://login.microsoftonline.com/your-ad-directory-id/v2.0", // DEV placeholder
  audience: "your-ad-audience",
  isActive: true,
  autoProvisionUsers: false,
  appRef: "crm-entra",
  directoryOwnership: "shared-nonprod",
  connectedAt: CONNECTED_AT,
  connectedBy: "c00000000000000000000001",
  lastTestedAt: TESTED_AT,
  lastTestResult: { ok: true, code: "OK" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...o,
});
const mockStoredB2C = (o = {}) => ({
  _id: CONN_B,
  id: CONN_B,
  connectionType: B2C,
  directoryId: "b2c-dir",
  isActive: true,
  autoProvisionUsers: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...o,
});
const mockReset = (connections) => {
  mockState.writes = [];
  mockState.tenants = {
    [A]: { _id: A, code: "MULTIAUTH", name: "Org", isActive: true, authenticationConnections: connections || [mockStoredEntra(), mockStoredB2C()] },
  };
};
const mockDoc = (t) => {
  const conns = t.authenticationConnections;
  conns.id = (cid) => conns.find((c) => String(c._id) === String(cid)) || null;
  t.save = async function () {
    mockState.writes.push(`save:${t._id}`);
    return this;
  };
  return t;
};
const mockLazy = (fn) => {
  const o = { select: () => o, lean: () => o, sort: () => o, then: (a, b) => Promise.resolve().then(fn).then(a, b) };
  return o;
};
jest.mock("../models/tenant.model", () => ({
  find: () => mockLazy(() => Object.values(mockState.tenants).map(mockDoc)),
  findOne: (q) =>
    mockLazy(() => {
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
  create: async (p) => ({ ...p, _id: "7ddddddddddddddddddddddd" }),
}));
jest.mock("../models/role.model", () => ({
  findOne: () => ({ select() { return this; }, lean: async () => null }),
  find: () => ({ select() { return this; }, sort() { return this; }, lean: async () => [] }),
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
  isTenantAdmin: (r) => !!r && r.includes("ASU"), isAssistantSuperUser: () => false, isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1, hasMinimumRole: () => false,
}));
jest.mock("../helpers/policyAdapter.js", () => ({ defaultPolicyAdapter: { middleware: () => (req, res, next) => next() } }));
// Phase B / Z5: POST /tenants is platform-authorized (platform:tenant:create, route-enforce). These suites
// test connection handling BEHIND that guard, so the platform evaluator is stubbed to allow exactly that code
// (the guard itself is covered by tests/platformRoutes.z5.test.js).
process.env.PLATFORM_AUTH_MODE = "shadow";
jest.mock("../services/platformAuthorizationService", () => ({
  REASONS: { NO_PLAT: "no_plat" },
  evaluatePlatformPermission: async ({ permission }) => (permission === "platform:tenant:create"
    ? { allowed: true, status: 200, reason: "allowed", pid: "6a0000000000000000000a07", tokenRev: 1, currentRev: 1, revMatch: true }
    // Z6: every other code answers as for a tenant actor (no platform claim), so the shared tenant routes
    // dispatch to their unchanged tenant chain (middlewares/platformTenantAdmin.js; covered by tests/platformTenantAdmin.z6.test.js).
    : { allowed: false, status: 403, reason: "no_plat", pid: null, tokenRev: null, currentRev: null, revMatch: null }),
}));
jest.mock("../services/platformAuditService", () => ({ auditAuthzDecision: () => {}, auditTenantCreated: () => {}, auditTenantCreateFailed: () => {}, auditClaimDecision: () => {} }));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    tenantContextWarn: (req, res, next) => next(),
    authenticate: (req, res, next) => {
      req.ctx = { tenantId: A, userId: "c00000000000000000000009", roles: ["SU"] };
      next();
    },
  };
});

let server;
let port;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/tenant.routes"));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: { message: err.message } }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  // Stage 5c-3: the activation guard does a directory-wide revoked-history lookup on DirectoryClaim
  // (isActivationBlockedByDisconnect); no history exists in this suite.
  jest.spyOn(require("../models/directoryClaim.model"), "find").mockImplementation(() => ({ lean: async () => [] }));
  mockReset();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function call(method, p, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { "content-type": "application/json" };
    if (data) h["content-length"] = Buffer.byteLength(data);
    const rq = http.request({ port, path: p, method, headers: h, timeout: 3000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null, raw: b }));
    });
    rq.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (data) rq.write(data);
    rq.end();
  });
}
const conns = () => mockState.tenants[A].authenticationConnections;
const entraNow = () => conns().find((c) => String(c._id) === CONN_E);
// What the deployed CRM form sends back: the connection objects it loaded (server-managed fields
// included if the API returned them), without fields it does not know.
const oldFormConnection = (c) => ({
  _id: c._id,
  connectionType: c.connectionType,
  issuerUrl: c.issuerUrl,
  directoryId: c.directoryId,
  audience: c.audience,
  isActive: c.isActive,
  autoProvisionUsers: c.autoProvisionUsers,
  ...(c.defaultRoleId ? { defaultRoleId: c.defaultRoleId } : {}),
});
const SERVER_MANAGED = {
  connectedAt: CONNECTED_AT,
  connectedBy: "c00000000000000000000001",
  lastTestedAt: TESTED_AT,
  lastTestResult: { ok: true, code: "OK" },
};
const resolve = (c, ctx) => require("../helpers/connectionAuthConfig").resolveConnectionAuthConfig(c, ctx);
const thrown = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

describe("resolver: the application is fixed server configuration (stored appRef is inert)", () => {
  const VARIANTS = [undefined, "crm-entra", "portal-b2c", "forged-app", { $ne: null }];
  test("A/B/C/D Entra always resolves to entraCrm, whatever appRef is stored (missing, valid, wrong provider, forged)", () => {
    const configs = VARIANTS.map((appRef) => resolve(mockStoredEntra({ appRef })));
    for (const c of configs) {
      expect(c).toMatchObject({ application: "entraCrm", clientId: process.env.AZURE_AD_CLIENT_ID, audience: process.env.AZURE_AD_CLIENT_ID, directoryId: HOME_DIR });
      expect(c).not.toHaveProperty("appRef");
    }
    const json = configs.map((c) => JSON.stringify(c));
    expect(new Set(json).size).toBe(1);
    expect(new Set(configs.map((c) => c.clientSecret)).size).toBe(1);
  });

  test("B2C always resolves to the legacy shared configuration, whatever appRef is stored", () => {
    const configs = VARIANTS.map((appRef) => resolve(mockStoredB2C({ appRef }), { policy: "B2C_1_projectshell_signin" }));
    for (const c of configs) expect(c).toMatchObject({ application: "legacySharedB2C", clientId: process.env.MS_CLIENT_ID });
    expect(new Set(configs.map((c) => JSON.stringify(c))).size).toBe(1);
  });

  test("O no per-connection fallback exists any more: no compatibility-application log line", () => {
    resolve(mockStoredEntra({ appRef: undefined }));
    resolve(mockStoredB2C(), { policy: "B2C_1_projectshell_signin" });
    expect(console.log.mock.calls.some((c) => /compatibility application/.test(String(c[0])))).toBe(false);
  });

  test("organisations are distinguished by directory only: same application, each its own directory", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const prev = process.env.AZURE_AD_TENANT_ID;
    process.env.AZURE_AD_TENANT_ID = OTHER;
    try {
      const b = resolve(mockStoredEntra({ directoryId: OTHER, appRef: "anything" }));
      expect(b.directoryId).toBe(OTHER);
      expect(b.issuer).toContain(`/${OTHER}/`);
      expect(b.clientId).toBe(process.env.AZURE_AD_CLIENT_ID);
    } finally {
      process.env.AZURE_AD_TENANT_ID = prev;
    }
    const a = resolve(mockStoredEntra());
    expect(a.directoryId).toBe(HOME_DIR);
    // The compatibility assertion still refuses a directory that is not enabled, whatever appRef says.
    expect(thrown(() => resolve(mockStoredEntra({ directoryId: OTHER, appRef: "crm-entra" })))).toMatchObject({ code: "DIRECTORY_NOT_ENABLED" });
  });

  test("application configuration: fixed profiles only; the secret reference never leaves the module", () => {
    const reg = require("../helpers/authAppRegistry");
    expect(reg.getAuthApp).toBeUndefined();
    expect(reg.isRegisteredAppRef).toBeUndefined();
    expect(reg.effectiveAppRef).toBeUndefined();
    const app = reg.getEntraCrmApp();
    expect(app).toMatchObject({ application: "entraCrm", multiDirectory: false, redirectUris: { default: process.env.AZURE_AD_REDIRECT_URI } });
    expect(JSON.stringify(app)).not.toMatch(/secretRef|AZURE_AD_CLIENT_SECRET/);
    expect(JSON.stringify(app)).not.toContain(SECRET);
  });
});

describe("saving connections (all write paths)", () => {
  test("C/D incoming appRef / directoryOwnership are ignored on every write path; stored values stay", async () => {
    const forged = { appRef: "forged-app", directoryOwnership: "customer" };
    let r = await call("PUT", `/api/tenants/${A}/auth-connections/${CONN_E}`, forged);
    expect(r.status).toBe(200);
    expect(entraNow()).toMatchObject({ appRef: "crm-entra", directoryOwnership: "shared-nonprod" });
    r = await call("PUT", `/api/tenants/${A}`, {
      authenticationConnections: [{ ...oldFormConnection(entraNow()), ...forged }, oldFormConnection(mockStoredB2C())],
    });
    expect(r.status).toBe(200);
    expect(entraNow()).toMatchObject({ appRef: "crm-entra", directoryOwnership: "shared-nonprod" });
    // A stored connection without them never acquires them from a request.
    const b2c = () => conns().find((c) => String(c._id) === CONN_B);
    r = await call("PUT", `/api/tenants/${A}/auth-connections/${CONN_B}`, { appRef: "portal-b2c", directoryOwnership: "projectshell-shared" });
    expect(r.status).toBe(200);
    expect(b2c()).not.toHaveProperty("appRef");
    expect(b2c()).not.toHaveProperty("directoryOwnership");
  });

  test("C/D new connections never acquire appRef / directoryOwnership from request data (add, full array, create)", async () => {
    const forged = { appRef: "crm-entra", directoryOwnership: "customer" };
    let r = await call("POST", `/api/tenants/${A}/auth-connections`, { connectionType: B2C, directoryId: "b2c-new", ...forged });
    expect(r.status).toBe(200);
    let added = conns().find((c) => c.directoryId === "b2c-new");
    expect(added).not.toHaveProperty("appRef");
    expect(added).not.toHaveProperty("directoryOwnership");
    r = await call("PUT", `/api/tenants/${A}`, {
      authenticationConnections: [...conns().map(oldFormConnection), { connectionType: B2C, directoryId: "b2c-3", ...forged }],
    });
    expect(r.status).toBe(200);
    added = conns().find((c) => c.directoryId === "b2c-3");
    expect(added).not.toHaveProperty("appRef");
    expect(added).not.toHaveProperty("directoryOwnership");
    const created = [];
    const Tenant = require("../models/tenant.model");
    const orig = Tenant.create;
    Tenant.create = async (p) => { created.push(p); return { ...p, _id: "7ddddddddddddddddddddddd" }; };
    try {
      r = await call("POST", `/api/tenants`, { name: "New", code: "NEWORG", domain: "new.example", authenticationConnections: [{ connectionType: ENTRA, directoryId: OTHER_GUID, ...forged }] });
    } finally {
      Tenant.create = orig;
    }
    expect(r.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0].authenticationConnections[0]).not.toHaveProperty("appRef");
    expect(created[0].authenticationConnections[0]).not.toHaveProperty("directoryOwnership");
  });

  test("E/F/H the old CRM form's full-array save keeps appRef, directoryOwnership and server-managed fields", async () => {
    const before = entraNow();
    const r = await call("PUT", `/api/tenants/${A}`, {
      name: "Renamed",
      authenticationConnections: [oldFormConnection(before), oldFormConnection(mockStoredB2C())],
    });
    expect(r.status).toBe(200);
    expect(mockState.tenants[A].name).toBe("Renamed");
    expect(entraNow()).toMatchObject({ appRef: "crm-entra", directoryOwnership: "shared-nonprod", ...SERVER_MANAGED });
  });

  test("E/F a changed connection (provisioning edit) also keeps appRef and server-managed fields", async () => {
    const r = await call("PUT", `/api/tenants/${A}`, {
      authenticationConnections: [{ ...oldFormConnection(entraNow()), isActive: false }, oldFormConnection(mockStoredB2C())],
    });
    expect(r.status).toBe(200);
    expect(entraNow()).toMatchObject({ isActive: false, appRef: "crm-entra", ...SERVER_MANAGED });
  });

  test("G a client cannot set or overwrite server-managed fields on any write path", async () => {
    const forged = { connectedAt: "1999-01-01T00:00:00.000Z", connectedBy: "attacker", lastTestedAt: "1999-01-01T00:00:00.000Z", lastTestResult: { ok: false, code: "FORGED" } };
    let r = await call("PUT", `/api/tenants/${A}`, {
      authenticationConnections: [{ ...oldFormConnection(entraNow()), ...forged }, oldFormConnection(mockStoredB2C())],
    });
    expect(r.status).toBe(200);
    expect(entraNow()).toMatchObject(SERVER_MANAGED);
    r = await call("PUT", `/api/tenants/${A}/auth-connections/${CONN_E}`, forged);
    expect(r.status).toBe(200);
    expect(entraNow()).toMatchObject(SERVER_MANAGED);
    r = await call("POST", `/api/tenants/${A}/auth-connections`, { connectionType: B2C, directoryId: "b2c-new", ...forged });
    expect(r.status).toBe(200);
    const added = conns().find((c) => c.directoryId === "b2c-new");
    for (const f of Object.keys(forged)) expect(added[f]).toBeUndefined();
    // New connection inside a full-array save: no server-managed fields either.
    r = await call("PUT", `/api/tenants/${A}`, {
      authenticationConnections: [...conns().map(oldFormConnection), { connectionType: B2C, directoryId: "b2c-3", ...forged }],
    });
    expect(r.status).toBe(200);
    const third = conns().find((c) => c.directoryId === "b2c-3");
    for (const f of Object.keys(forged)) expect(third[f]).toBeUndefined();
  });

  test("H unknown fields are dropped; an emptied appRef / directoryOwnership is ignored (stored values stay)", async () => {
    let r = await call("PUT", `/api/tenants/${A}/auth-connections/${CONN_E}`, { clientSecret: "x", clientId: "y", secretRef: "z", foo: 1 });
    expect(r.status).toBe(200);
    expect(entraNow()).not.toHaveProperty("clientSecret");
    expect(entraNow()).not.toHaveProperty("secretRef");
    expect(entraNow()).not.toHaveProperty("foo");
    r = await call("PUT", `/api/tenants/${A}/auth-connections/${CONN_E}`, { appRef: "", directoryOwnership: null });
    expect(r.status).toBe(200);
    expect(entraNow()).toMatchObject({ appRef: "crm-entra", directoryOwnership: "shared-nonprod" });
  });

  test("I issuerUrl / audience may be absent on a new connection (schema and save rules)", async () => {
    mockReset([mockStoredEntra({ isActive: false }), mockStoredB2C()]); // one active Entra connection per organisation
    const r = await call("POST", `/api/tenants/${A}/auth-connections`, { connectionType: ENTRA, directoryId: OTHER_GUID });
    expect(r.status).toBe(200);
    const Tenant = jest.requireActual("../models/tenant.model");
    const doc = new Tenant({ name: "n", code: "C", domain: "c.example", authenticationConnections: [{ connectionType: ENTRA, directoryId: OTHER_GUID }] });
    const err = doc.validateSync();
    const connErrors = err ? Object.keys(err.errors).filter((k) => k.startsWith("authenticationConnections")) : [];
    expect(connErrors).toEqual([]);
  });

  test("J issuerUrl is still validated when supplied", async () => {
    mockReset([mockStoredEntra({ isActive: false }), mockStoredB2C()]); // one active Entra connection per organisation
    const r = await call("POST", `/api/tenants/${A}/auth-connections`, { connectionType: ENTRA, directoryId: OTHER_GUID, issuerUrl: "https://evil.example/v2.0" });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/Issuer URL/);
    const Tenant = jest.requireActual("../models/tenant.model");
    const doc = new Tenant({ name: "n", code: "C", domain: "c.example", authenticationConnections: [{ connectionType: ENTRA, directoryId: OTHER_GUID, issuerUrl: "https://evil.example/v2.0" }] });
    expect(Object.keys(doc.validateSync().errors)).toContain("authenticationConnections.0.issuerUrl");
  });

  test("K a new or changed Entra connection needs a GUID directory id", async () => {
    mockReset([mockStoredEntra({ isActive: false }), mockStoredB2C()]); // one active Entra connection per organisation
    let r = await call("POST", `/api/tenants/${A}/auth-connections`, { connectionType: ENTRA, directoryId: "your-ad-directory-id" });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/GUID/);
    r = await call("PUT", `/api/tenants/${A}/auth-connections/${CONN_E}`, { directoryId: "not-a-guid" });
    expect(r.status).toBe(400);
    r = await call("POST", `/api/tenants`, { name: "New", code: "NEWORG", domain: "new.example", authenticationConnections: [{ connectionType: ENTRA, directoryId: "x" }] });
    expect(r.status).toBe(400);
    r = await call("POST", `/api/tenants/${A}/auth-connections`, { connectionType: B2C, directoryId: "b2c-not-guid" });
    expect(r.status).toBe(200); // the GUID rule is Entra-only
  });

  test("L an untouched grandfathered connection does not block an unrelated tenant save", async () => {
    mockReset([mockStoredEntra({ directoryId: "legacy-not-a-guid", issuerUrl: "i", appRef: undefined }), mockStoredB2C()]);
    const r = await call("PUT", `/api/tenants/${A}`, {
      description: "unrelated edit",
      authenticationConnections: conns().map(oldFormConnection),
    });
    expect(r.status).toBe(200);
    expect(entraNow().directoryId).toBe("legacy-not-a-guid");
  });

  test("old clients can still save unrelated tenant fields without sending connections", async () => {
    const r = await call("PUT", `/api/tenants/${A}`, { description: "only this" });
    expect(r.status).toBe(200);
    expect(entraNow()).toMatchObject({ appRef: "crm-entra", ...SERVER_MANAGED });
  });
});

describe("responses (allow-list)", () => {
  const ALLOWED = new Set([
    "_id", "connectionType", "directoryId", "issuerUrl", "audience", "isActive", "autoProvisionUsers", "defaultRoleId",
    "connectedAt", "connectedBy", "lastTestedAt", "lastTestResult",
    "createdAt", "updatedAt",
  ]);
  const poison = () => {
    const e = mockStoredEntra({ clientSecret: SECRET, clientId: "leak-client", secretRef: { source: "env", name: "AZURE_AD_CLIENT_SECRET" }, redirectUri: "https://leak.example", internalNote: "x" });
    e.lastTestResult = { ok: true, code: "OK", raw: "provider-message" };
    mockReset([e, mockStoredB2C()]);
  };
  const expectSafe = (connections) => {
    expect(Array.isArray(connections)).toBe(true);
    for (const c of connections) {
      for (const k of Object.keys(c)) expect(ALLOWED.has(k)).toBe(true);
      if (c.lastTestResult) expect(Object.keys(c.lastTestResult).sort()).toEqual(["code", "ok"]);
      for (const k of ["appRef", "effectiveAppRef", "directoryOwnership"]) expect(c).not.toHaveProperty(k);
    }
  };

  test("M/N every tenant / connection endpoint returns allow-listed connections only", async () => {
    const responses = [];
    const run = async (method, p, body, pick) => {
      poison();
      const r = await call(method, p, body);
      if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${r.raw.slice(0, 120)}`);
      expect(r.raw).not.toContain(SECRET);
      expect(r.raw).not.toMatch(/leak-client|leak\.example|secretRef|AZURE_AD_CLIENT_SECRET|internalNote|provider-message|appRef|directoryOwnership|crm-entra|shared-nonprod/);
      responses.push(p);
      expectSafe(pick(r.body.data));
    };
    await run("GET", `/api/tenants`, undefined, (d) => d[0].authenticationConnections);
    await run("GET", `/api/tenants/${A}`, undefined, (d) => d.authenticationConnections);
    await run("PUT", `/api/tenants/${A}`, { description: "x" }, (d) => d.authenticationConnections);
    await run("PUT", `/api/tenants/${A}/status`, { status: "ACTIVE" }, (d) => d.authenticationConnections);
    await run("GET", `/api/tenants/${A}/auth-connections`, undefined, (d) => d);
    await run("POST", `/api/tenants/${A}/auth-connections`, { connectionType: B2C, directoryId: "b2c-x" }, (d) => d.authenticationConnections);
    await run("PUT", `/api/tenants/${A}/auth-connections/${CONN_E}`, { isActive: true }, (d) => d.authenticationConnections);
    await run("DELETE", `/api/tenants/${A}/auth-connections/${CONN_B}`, undefined, (d) => d.authenticationConnections);
    await run("PATCH", `/api/tenants/${A}/organisation-profile`, { supportEmail: "support@example.org" }, (d) => d.authenticationConnections);
    expect(responses).toHaveLength(9);
  });

  test("M every tenant-returning response in the controller goes through the serializer", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "tenant.controller.js"), "utf8");
    expect(src).not.toMatch(/data:\s*tenants?\s*\}/);
    expect(src).not.toMatch(/res\.success\((tenant|connections)\)/);
    expect((src.match(/toTenantView\(/g) || []).length).toBeGreaterThanOrEqual(12);
    expect(src).toMatch(/tenants\.map\(toTenantView\)/);
    expect(src).toMatch(/connections\.map\(toConnectionView\)/);
  });
});
