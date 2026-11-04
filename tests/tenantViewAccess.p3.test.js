/**
 * PDP rollout P3 (Q3 / review package E.1, O6 / N3) - tenant documents per caller, the authentication-configuration
 * read guard, and the internal creditor-profile endpoint.
 *
 * Mounts the REAL tenant router + REAL tenant controller. Stubbed: authenticate (identity from x-test-* headers in
 * place of the gateway-verified req.ctx), the PDP adapter (allow), the tenant handler (one full tenant document),
 * the platform evaluator (allowed permissions from an `authorization: Plat <json>` test header), the platform audit.
 *
 *   ORG       always (route guard passed)
 *   ORG-BANK  organisationProfile.{iban,bic,bankName,bankAddress}: "*" | payments.bank:read | tenant:update
 *   SECURITY  authenticationConnections, settings.{passwordPolicy,sessionTimeout,allowSelfRegistration,maxUsers},
 *             subscription, createdBy, updatedBy: "*" | tenant.auth:read
 *   platform  never ORG-BANK; SECURITY only with platform:tenant:auth-connections:manage:any
 */
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");

const A = "6acd6119b28a863c61361ae0";
const OTHER = "6acd6119b28a863c61361ae1";
const READ_ANY = "platform:tenant:read:any";
const UPDATE_ANY = "platform:tenant:update:any";
const CONNECTIONS_ANY = "platform:tenant:auth-connections:manage:any";

jest.mock("../rabbitMQ", () => ({ publishDomainEvent: () => Promise.resolve(true) }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: () => false, isAssistantSuperUser: () => false, isSystemAdmin: () => false, getHighestRoleLevel: () => 1, hasMinimumRole: () => false,
}));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    authenticate: (req, res, next) => {
      const t = req.headers["x-test-tenant"];
      if (t) req.ctx = { tenantId: t, userId: "6a00000000000000000000a1", roles: JSON.parse(req.headers["x-test-roles"] || "[]"), permissions: JSON.parse(req.headers["x-test-perms"] || "[]") };
      next();
    },
    tenantContextWarn: (req, res, next) => next(),
  };
});
jest.mock("../helpers/policyAdapter.js", () => ({ defaultPolicyAdapter: { middleware: () => (req, res, next) => next() } }));
jest.mock("../middlewares/upload.mw", () => ({ brandingAssetUploadMw: (req, res, next) => next(), brandingAssetUpload: {}, ALLOWED_IMAGE_TYPES: [] }));
jest.mock("../services/platformAuditService", () => ({
  auditAuthzDecision: () => {}, auditTenantAdminChange: () => {}, auditTenantCreated: () => {}, auditTenantCreateFailed: () => {}, auditClaimDecision: () => {},
}));
process.env.PLATFORM_AUTH_MODE = "shadow";
jest.mock("../services/platformAuthorizationService", () => ({
  REASONS: { NO_PLAT: "no_plat", JWT_MISSING: "jwt_missing", JWT_INVALID: "jwt_invalid", JWT_CTX_MISMATCH: "jwt_ctx_mismatch", LOOKUP_ERROR: "lookup_error" },
  evaluatePlatformPermission: jest.fn(async ({ authorization, permission }) => {
    const m = /^Plat (.*)$/.exec(String(authorization || ""));
    if (!m) return { allowed: false, status: 403, reason: "no_plat", pid: null };
    const held = JSON.parse(m[1]);
    return held.includes(permission)
      ? { allowed: true, status: 200, reason: "allowed", pid: "6a0000000000000000000a07", tokenRev: 1, currentRev: 1, revMatch: true }
      : { allowed: false, status: 403, reason: "permission_missing", pid: "6a0000000000000000000a07" };
  }),
}));

const mockTenantDoc = () => ({
  _id: A,
  name: "Org A",
  code: "ORGA",
  description: "d",
  domain: "orga.example",
  contactEmail: "info@orga.example",
  address: { street: "1 Street", city: "Dublin", country: "IE" },
  organisationProfile: {
    legalName: "Org A Ltd",
    tradingName: "Org A",
    sepaOriginatorIdentificationNumber: "IE00ZZZ000000",
    bankName: "Test Bank",
    bankAddress: { areaOrTown: "Dublin" },
    iban: "IE29AIBK93115212345678",
    bic: "AIBKIE2DXXX",
  },
  branding: { primaryColor: "#000000" },
  regionalSettings: { timezone: "Europe/Dublin" },
  settings: {
    lifecycleBatches: { enabled: true },
    passwordPolicy: { minLength: 12 },
    sessionTimeout: 24,
    allowSelfRegistration: true,
    maxUsers: 100,
  },
  subscription: { plan: "enterprise", autoRenew: true },
  authenticationConnections: [{ _id: "c1", connectionType: "ENTRA", directoryId: "dir", isActive: true, clientSecret: "never" }],
  createdBy: "creator",
  updatedBy: "updater",
  status: "ACTIVE",
  isActive: true,
});
jest.mock("../handlers/tenant.handler", () => ({
  getAllTenants: jest.fn(async () => [mockTenantDoc()]),
  getTenantById: jest.fn(async () => mockTenantDoc()),
  getTenantByCode: jest.fn(async () => mockTenantDoc()),
  getTenantByDomain: jest.fn(async () => mockTenantDoc()),
  updateTenant: jest.fn(async () => mockTenantDoc()),
  updateOrganisationProfile: jest.fn(async () => mockTenantDoc()),
  updateBranding: jest.fn(async () => mockTenantDoc()),
  updateRegionalSettings: jest.fn(async () => mockTenantDoc()),
  getAuthenticationConnections: jest.fn(async () => mockTenantDoc().authenticationConnections),
  getDefaultRoleOptions: jest.fn(async () => []),
}));
jest.mock("../handlers/entraConnect.handler", () => ({ getConnectionStatus: jest.fn(async () => ({ status: "connected" })) }));

const Tenant = require("../models/tenant.model");
const { applyTenantViewAccess, tenantViewForCaller } = require("../helpers/tenantViewAccess");
const { toCreditorProfileView } = require("../controllers/internalTenantCreditorProfile.controller");

let server;
let port;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/tenant.routes"));
  app.use("/internal", require("../routes/internalTenantCreditorProfile.routes"));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: { message: err.message, code: err.code } }));
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  jest.spyOn(Tenant, "findOne").mockImplementation(() => ({ select: () => ({ lean: async () => mockTenantDoc() }) }));
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.INTERNAL_TENANT_PROFILE_SECRET;
});

function call(method, p, headers = {}, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { json = null; }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    if (data) req.write(data);
    req.end();
  });
}
const asTenant = (perms, roles = ["MO"]) => ({ "x-test-tenant": A, "x-test-roles": JSON.stringify(roles), "x-test-perms": JSON.stringify(perms) });
const asPlatform = (platPerms) => ({ "x-test-tenant": A, "x-test-roles": "[]", "x-test-perms": "[]", authorization: `Plat ${JSON.stringify(platPerms)}` });

const BANK_KEYS = ["iban", "bic", "bankName", "bankAddress"];
const SECURITY_SETTINGS = ["passwordPolicy", "sessionTimeout", "allowSelfRegistration", "maxUsers"];
const SECURITY_TOP = ["authenticationConnections", "subscription", "createdBy", "updatedBy"];

function groupsOf(doc) {
  const org = doc.organisationProfile || {};
  const settings = doc.settings || {};
  const bank = BANK_KEYS.filter((k) => k in org);
  const security = [...SECURITY_TOP.filter((k) => k in doc), ...SECURITY_SETTINGS.filter((k) => k in settings)];
  return {
    org: Boolean(doc.name && doc.code && org.legalName && org.sepaOriginatorIdentificationNumber && doc.branding && doc.regionalSettings && settings.lifecycleBatches),
    bank: bank.length === BANK_KEYS.length ? true : bank.length === 0 ? false : `partial:${bank}`,
    security: security.length === SECURITY_TOP.length + SECURITY_SETTINGS.length ? true : security.length === 0 ? false : `partial:${security}`,
  };
}

// Every tenant-document response of the tenant chain: [method, path, body, pick(data) -> one tenant doc].
const TENANT_DOC_ROUTES = [
  ["GET", "/api/tenants", undefined, (d) => d[0]],
  ["GET", `/api/tenants/${A}`, undefined, (d) => d],
  ["GET", "/api/tenants/code/ORGA", undefined, (d) => d],
  ["GET", "/api/tenants/domain/orga.example", undefined, (d) => d],
  ["PUT", `/api/tenants/${A}`, { description: "x" }, (d) => d],
  ["PATCH", `/api/tenants/${A}/organisation-profile`, { tradingName: "Org A" }, (d) => d],
  ["PATCH", `/api/tenants/${A}/branding`, { primaryColor: "#111111" }, (d) => d],
  ["PATCH", `/api/tenants/${A}/regional-settings`, { timezone: "Europe/Dublin" }, (d) => d],
];

describe("tenant documents per caller (tenant chain, own tenant)", () => {
  const CASES = [
    ["tenant:read only (MO / REO after P5)", ["tenant:read"], { org: true, bank: false, security: false }],
    ["tenant:read + tenant:write (live MO/REO shape)", ["tenant:read", "tenant:write"], { org: true, bank: false, security: false }],
    ["payments.bank:read", ["tenant:read", "payments.bank:read"], { org: true, bank: true, security: false }],
    ["tenant:update (organisation edit form)", ["tenant:read", "tenant:update"], { org: true, bank: true, security: false }],
    ["tenant.auth:read", ["tenant:read", "tenant.auth:read"], { org: true, bank: false, security: true }],
    ["tenant:admin alone is not tenant.auth:read", ["tenant:read", "tenant:admin"], { org: true, bank: false, security: false }],
    ["CODE-format claims are not token claims", ["tenant:read", "PAYMENTS.BANK_READ", "TENANT.AUTH_READ"], { org: true, bank: false, security: false }],
    ["payments:* / admin do not unlock bank data", ["tenant:read", "payments:*", "payments:read", "admin"], { org: true, bank: false, security: false }],
    ["ASU (computed *)", ["*"], { org: true, bank: true, security: true }],
  ];
  for (const [label, perms, expected] of CASES) {
    test(`${label}: same groups on list, by id, code, domain and PUT/PATCH responses`, async () => {
      for (const [method, p, body, pick] of TENANT_DOC_ROUTES) {
        const r = await call(method, p, asTenant(perms, perms.includes("*") ? ["ASU"] : ["MO"]), body);
        expect({ p, method, status: r.status }).toEqual({ p, method, status: 200 });
        expect({ p, method, groups: groupsOf(pick(r.body.data)) }).toEqual({ p, method, groups: expected });
        expect(r.raw).not.toContain("never"); // the connection allow-list still applies
      }
    });
  }

  test("a document of another tenant is reduced to ORG even for *", async () => {
    const req = { ctx: { tenantId: OTHER, permissions: ["*"] }, headers: {} };
    expect(groupsOf(await tenantViewForCaller(req, mockTenantDoc()))).toEqual({ org: true, bank: false, security: false });
    const noCtx = { headers: {} };
    expect(groupsOf(await tenantViewForCaller(noCtx, mockTenantDoc()))).toEqual({ org: true, bank: false, security: false });
  });

  test("applyTenantViewAccess is pure and keeps the non-security settings (lifecycleBatches)", () => {
    const doc = mockTenantDoc();
    const out = applyTenantViewAccess(doc, { canBank: false, canSecurity: false });
    expect(out.settings).toEqual({ lifecycleBatches: { enabled: true } });
    expect(out.organisationProfile.sepaOriginatorIdentificationNumber).toBe("IE00ZZZ000000");
    expect(doc.organisationProfile.iban).toBeDefined();
    expect(doc.authenticationConnections).toHaveLength(1);
  });
});

describe("platform principal", () => {
  test("read:any: ORG only (no bank, no auth connections / security settings) on by-id and list", async () => {
    for (const p of [`/api/tenants/${A}`, "/api/tenants"]) {
      const r = await call("GET", p, asPlatform([READ_ANY]));
      expect(r.status).toBe(200);
      const doc = Array.isArray(r.body.data) ? r.body.data[0] : r.body.data;
      expect(groupsOf(doc)).toEqual({ org: true, bank: false, security: false });
    }
  });

  test("read:any + auth-connections:manage:any: SECURITY returned, still never ORG-BANK", async () => {
    const r = await call("GET", `/api/tenants/${A}`, asPlatform([READ_ANY, CONNECTIONS_ANY]));
    expect(r.status).toBe(200);
    expect(groupsOf(r.body.data)).toEqual({ org: true, bank: false, security: true });
  });

  test("update:any response (organisation profile): no bank fields, no security without CONNECTIONS_ANY", async () => {
    const r = await call("PATCH", `/api/tenants/${A}/organisation-profile`, asPlatform([UPDATE_ANY]), { tradingName: "Org A" });
    expect(r.status).toBe(200);
    expect(groupsOf(r.body.data)).toEqual({ org: true, bank: false, security: false });
  });
});

describe("authentication-configuration reads need tenant.auth:read", () => {
  const READS = [
    `/api/tenants/${A}/auth-connections`,
    `/api/tenants/${A}/auth-connections/c1/status`,
    `/api/tenants/${A}/auth-connections/default-role-options`,
  ];
  test("tenant:read / tenant:admin / payments.bank:read -> 403 TENANT_AUTH_READ_REQUIRED", async () => {
    for (const perms of [["tenant:read"], ["tenant:read", "tenant:admin"], ["tenant:read", "payments.bank:read"], []]) {
      for (const p of READS) {
        const r = await call("GET", p, asTenant(perms));
        expect({ p, perms, status: r.status, code: r.body?.error?.code }).toEqual({ p, perms, status: 403, code: "TENANT_AUTH_READ_REQUIRED" });
      }
    }
  });
  test("tenant.auth:read or * -> 200; another tenant's path is still refused first", async () => {
    for (const perms of [["tenant.auth:read"], ["*"]]) {
      for (const p of READS) {
        expect({ p, status: (await call("GET", p, asTenant(perms))).status }).toEqual({ p, status: 200 });
        const other = await call("GET", p.replace(A, OTHER), asTenant(perms));
        expect([other.status, other.body?.error?.tenantScopeViolation]).toEqual([403, true]);
      }
    }
  });
});

describe("internal creditor profile (O6 / N3)", () => {
  const SECRET = "p3-creditor-profile-test-secret-0123456789";
  const url = `/internal/tenants/${A}/creditor-profile`;

  test("secret unset / short / wrong -> 403 (fail closed)", async () => {
    expect((await call("GET", url, { "x-service-secret": SECRET, "x-tenant-id": A })).status).toBe(403);
    process.env.INTERNAL_TENANT_PROFILE_SECRET = "short";
    expect((await call("GET", url, { "x-service-secret": "short", "x-tenant-id": A })).status).toBe(403);
    process.env.INTERNAL_TENANT_PROFILE_SECRET = SECRET;
    expect((await call("GET", url, { "x-service-secret": `${SECRET}x`, "x-tenant-id": A })).status).toBe(403);
    expect((await call("GET", url, { "x-tenant-id": A })).status).toBe(403);
    // a user token does not substitute for the service secret
    expect((await call("GET", url, { ...asTenant(["*"]), "x-tenant-id": A, authorization: "Bearer user" })).status).toBe(403);
  });

  test("tenant id: path must be an id and equal x-tenant-id", async () => {
    process.env.INTERNAL_TENANT_PROFILE_SECRET = SECRET;
    expect((await call("GET", url, { "x-service-secret": SECRET, "x-tenant-id": OTHER })).status).toBe(400);
    expect((await call("GET", url, { "x-service-secret": SECRET })).status).toBe(400);
    expect((await call("GET", "/internal/tenants/not-an-id/creditor-profile", { "x-service-secret": SECRET, "x-tenant-id": "not-an-id" })).status).toBe(400);
  });

  test("valid call: ORG + creditor bank fields only; never settings / subscription / connections / createdBy", async () => {
    process.env.INTERNAL_TENANT_PROFILE_SECRET = SECRET;
    const r = await call("GET", url, { "x-service-secret": SECRET, "x-tenant-id": A });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual(["branding", "code", "name", "organisationProfile", "tenantId"]);
    expect(r.body.data.organisationProfile).toMatchObject({ iban: "IE29AIBK93115212345678", bic: "AIBKIE2DXXX", bankName: "Test Bank", sepaOriginatorIdentificationNumber: "IE00ZZZ000000", legalName: "Org A Ltd" });
    expect(r.raw).not.toMatch(/passwordPolicy|authenticationConnections|enterprise|creator|updater/);
    expect(toCreditorProfileView({ ...mockTenantDoc(), organisationProfile: { iban: "X", internalNote: "y" } }).organisationProfile).toEqual({ iban: "X" });
  });

  test("mounted outside /api (the gateway proxies only /user-service/{api,auth,pkce}) - never on an /api router", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "index.js"), "utf8");
    expect(src).toMatch(/router\.use\("\/internal", require\("\.\/internalTenantCreditorProfile\.routes"\)\)/);
    expect(src).not.toMatch(/router\.use\("\/api", require\("\.\/internalTenantCreditorProfile\.routes"\)\)/);
  });
});
