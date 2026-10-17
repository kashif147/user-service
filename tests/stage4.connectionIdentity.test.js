/**
 * Stage 4 (approved authentication architecture): the CRM application is fixed server
 * configuration and a connection is identified by provider + directory.
 *
 *  - Identity rule on the FINAL proposed connection list, on every write path (create tenant, add
 *    connection, update connection, full-array replace): among active connections at most one
 *    Microsoft Entra connection per organisation, and no two connections of the same provider for
 *    the same directory (case-insensitive). Old conflicts are grandfathered for unrelated saves;
 *    new conflicts, or edits that create or touch one, are refused.
 *  - A stored appRef (inert legacy data) has no effect on CRM sign-in.
 *
 * Harness and in-memory models as tests/phase3b.connectionSchema.test.js.
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


const UPPER = (g) => String(g).toUpperCase();
const ENTRA_2 = "f00000000000000000000003";
const B2C_2 = "f00000000000000000000004";
const entraNew = (o = {}) => ({ connectionType: ENTRA, directoryId: OTHER_GUID, ...o });
const IDENTITY_ENTRA = /only one active Microsoft Entra connection/;
const IDENTITY_DUP = /Directory ID already exists/;
const add = (body) => call("POST", `/api/tenants/${A}/auth-connections`, body);
const update = (id, body) => call("PUT", `/api/tenants/${A}/auth-connections/${id}`, body);
const fullSave = (list) => call("PUT", `/api/tenants/${A}`, { authenticationConnections: list });

describe("connection identity: one active Entra connection per organisation", () => {
  test("add: a second ACTIVE Entra connection is refused (an inactive one is allowed)", async () => {
    let r = await add(entraNew());
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(IDENTITY_ENTRA);
    expect(mockState.writes).toEqual([]);
    r = await add(entraNew({ isActive: false }));
    expect(r.status).toBe(200);
  });

  test("update: activating a second Entra connection is refused", async () => {
    mockReset([mockStoredEntra(), mockStoredEntra({ _id: ENTRA_2, id: ENTRA_2, directoryId: OTHER_GUID, isActive: false }), mockStoredB2C()]);
    const r = await update(ENTRA_2, { isActive: true });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(IDENTITY_ENTRA);
    expect(mockState.writes).toEqual([]);
  });

  test("full array: adding or activating a second Entra connection is refused", async () => {
    let r = await fullSave([...conns().map(oldFormConnection), entraNew()]);
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(IDENTITY_ENTRA);
    mockReset([mockStoredEntra(), mockStoredEntra({ _id: ENTRA_2, id: ENTRA_2, directoryId: OTHER_GUID, isActive: false }), mockStoredB2C()]);
    r = await fullSave(conns().map((c) => ({ ...oldFormConnection(c), ...(String(c._id) === ENTRA_2 ? { isActive: true } : {}) })));
    expect(r.status).toBe(400);
    expect(mockState.writes).toEqual([]);
  });

  test("create tenant: two active Entra connections are refused", async () => {
    const r = await call("POST", `/api/tenants`, {
      name: "New", code: "NEWORG", domain: "new.example",
      authenticationConnections: [entraNew(), entraNew({ directoryId: HOME_DIR })],
    });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(IDENTITY_ENTRA);
  });
});

describe("connection identity: provider + directory (case-insensitive)", () => {
  test("add: same provider + same directory (different case) is refused; another provider may use it", async () => {
    let r = await add({ connectionType: B2C, directoryId: UPPER("b2c-dir") });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(IDENTITY_DUP);
    mockReset([mockStoredEntra({ isActive: false }), mockStoredB2C({ directoryId: OTHER_GUID })]);
    r = await add({ connectionType: ENTRA, directoryId: UPPER(OTHER_GUID) }); // Entra + B2C may share a directory id
    expect(r.status).toBe(200);
  });

  test("an inactive Entra duplicate (same GUID, different case) cannot be re-activated", async () => {
    mockReset([mockStoredEntra(), mockStoredEntra({ _id: ENTRA_2, id: ENTRA_2, directoryId: UPPER(HOME_DIR), isActive: false }), mockStoredB2C()]);
    const r = await update(ENTRA_2, { isActive: true });
    expect(r.status).toBe(400);
  });

  test("reactivating an inactive duplicate (same provider + directory) is refused on update and full array", async () => {
    // B2C, so only the provider + directory rule applies (the one-active-Entra rule cannot mask it).
    const inactiveDup = () =>
      mockReset([mockStoredEntra(), mockStoredB2C(), mockStoredB2C({ _id: B2C_2, id: B2C_2, directoryId: "B2C-DIR", isActive: false })]);
    inactiveDup();
    let r = await call("PUT", `/api/tenants/${A}`, { description: "unrelated" }); // the inactive duplicate is harmless
    expect(r.status).toBe(200);
    r = await update(B2C_2, { isActive: true });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(IDENTITY_DUP);
    inactiveDup();
    r = await fullSave(conns().map((c) => ({ ...oldFormConnection(c), ...(String(c._id) === B2C_2 ? { isActive: true } : {}) })));
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(IDENTITY_DUP);
    expect(mockState.writes).toEqual([]);
    // Reactivating it after the other one is deactivated is fine.
    inactiveDup();
    conns().find((c) => String(c._id) === CONN_B).isActive = false;
    r = await update(B2C_2, { isActive: true });
    expect(r.status).toBe(200);
  });

  test("update / full array: moving a connection onto another's directory is refused", async () => {
    mockReset([mockStoredEntra(), mockStoredB2C(), mockStoredB2C({ _id: B2C_2, id: B2C_2, directoryId: "b2c-other" })]);
    let r = await update(B2C_2, { directoryId: "B2C-DIR" });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(IDENTITY_DUP);
    r = await fullSave(conns().map((c) => ({ ...oldFormConnection(c), ...(String(c._id) === B2C_2 ? { directoryId: "b2c-dir" } : {}) })));
    expect(r.status).toBe(400);
    expect(mockState.writes).toEqual([]);
  });

  test("create tenant: duplicate provider + directory refused; Entra + B2C on one directory id allowed", async () => {
    let r = await call("POST", `/api/tenants`, {
      name: "New", code: "NEWORG", domain: "new.example",
      authenticationConnections: [{ connectionType: B2C, directoryId: "x-dir" }, { connectionType: B2C, directoryId: "X-DIR" }],
    });
    expect(r.status).toBe(400);
    r = await call("POST", `/api/tenants`, {
      name: "New", code: "NEWORG", domain: "new.example",
      authenticationConnections: [entraNew(), { connectionType: B2C, directoryId: OTHER_GUID }],
    });
    expect(r.status).toBe(201);
  });
});

describe("connection identity: grandfathering", () => {
  const legacyTwoActive = () =>
    mockReset([mockStoredEntra(), mockStoredEntra({ _id: ENTRA_2, id: ENTRA_2, directoryId: OTHER_GUID }), mockStoredB2C()]);

  test("an existing conflict does not block unrelated saves or unchanged resends", async () => {
    legacyTwoActive();
    let r = await call("PUT", `/api/tenants/${A}`, { description: "unrelated" });
    expect(r.status).toBe(200);
    r = await fullSave(conns().map(oldFormConnection));
    expect(r.status).toBe(200);
    r = await update(ENTRA_2, { autoProvisionUsers: false }); // provisioning edit, identity unchanged
    expect(r.status).toBe(200);
  });

  test("but a new conflict, or an edit that touches the conflict, is refused", async () => {
    legacyTwoActive();
    let r = await add(entraNew({ directoryId: "44444444-4444-4444-8444-444444444444" }));
    expect(r.status).toBe(400);
    r = await update(ENTRA_2, { directoryId: "55555555-5555-4555-8555-555555555555" });
    expect(r.status).toBe(400);
    expect(mockState.writes).toEqual([]);
    // Resolving the conflict (deactivating one) is allowed.
    r = await update(ENTRA_2, { isActive: false });
    expect(r.status).toBe(200);
  });

  test("the DEV shape (one active Entra + one active B2C per organisation) saves on every path", async () => {
    let r = await fullSave(conns().map(oldFormConnection));
    expect(r.status).toBe(200);
    r = await update(CONN_E, { autoProvisionUsers: false });
    expect(r.status).toBe(200);
    r = await update(CONN_B, { isActive: true });
    expect(r.status).toBe(200);
  });
});

describe("CRM sign-in ignores the stored appRef", () => {
  test("the state-bound connection resolves to the shared CRM application even with a forged appRef", async () => {
    const AzureADHandler = require("../handlers/azure.ad.handler");
    for (const appRef of [undefined, "crm-entra", "portal-b2c", "forged-app"]) {
      mockReset([mockStoredEntra({ appRef }), mockStoredB2C()]);
      const config = await AzureADHandler.resolveAuthConfig({ tenantId: A, connectionId: CONN_E });
      expect(config).toMatchObject({ application: "entraCrm", clientId: process.env.AZURE_AD_CLIENT_ID, directoryId: HOME_DIR, connectionId: CONN_E });
    }
  });
});
