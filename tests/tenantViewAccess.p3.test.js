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
    sortCodeLegacy: "UNKNOWN-ORG-PROFILE",
  },
  branding: { primaryColor: "#000000", trackingPixel: "UNKNOWN-BRANDING" },
  regionalSettings: { timezone: "Europe/Dublin" },
  settings: {
    lifecycleBatches: { reminder: { generateMode: "manual", executeMode: "manual" }, notificationRecipientRoleCodes: ["MO"], internalFlag: "drop-me" },
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
  // Unknown / not-allow-listed fields at every level: never returned to anyone (ASU included).
  __v: 3,
  internalNotes: "UNKNOWN-TOP-LEVEL",
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

// Signed-route dependencies: env per test and an in-memory nonce store with the same unique semantics.
const mockNonces = new Set();
const mockSignDeps = {
  env: {},
  storeReady: async () => true,
  NonceModel: {
    create: async ({ caller, nonce }) => {
      const k = `${caller}|${nonce}`;
      if (mockNonces.has(k)) { const e = new Error("dup"); e.code = 11000; throw e; }
      mockNonces.add(k);
    },
  },
  logger: { info: () => {}, warn: () => {} },
};
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
  app.use("/internal", require("../routes/internalTenantCreditorProfile.routes").createCreditorProfileRouter(mockSignDeps));
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
  mockSignDeps.env = {};
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
    expect(out.settings).toEqual({ lifecycleBatches: { reminder: { generateMode: "manual", executeMode: "manual" }, notificationRecipientRoleCodes: ["MO"] } });
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

describe("allow-lists: unknown fields are never returned", () => {
  test("no caller (tenant:read, bank, auth, ASU, platform) ever sees a field outside the allow-lists", async () => {
    const callers = [asTenant(["tenant:read"]), asTenant(["payments.bank:read"]), asTenant(["tenant.auth:read"]), asTenant(["*"], ["ASU"]), asPlatform([READ_ANY, CONNECTIONS_ANY])];
    for (const h of callers) {
      for (const [method, p, body] of TENANT_DOC_ROUTES) {
        if (h.authorization && method !== "GET") continue;
        const r = await call(method, p, h, body);
        expect(r.status).toBe(200);
        expect(r.raw).not.toMatch(/UNKNOWN-|drop-me|"__v"|internalNotes|sortCodeLegacy|trackingPixel|internalFlag/);
      }
    }
  });
  test("an unknown field is returned only through an explicit allow-list entry", () => {
    const { pickInto, applyTenantViewAccess } = require("../helpers/tenantViewAccess");
    const doc = mockTenantDoc();
    expect(applyTenantViewAccess(doc, { canBank: true, canSecurity: true })).not.toHaveProperty("internalNotes");
    expect(pickInto({}, doc, { internalNotes: true })).toEqual({ internalNotes: "UNKNOWN-TOP-LEVEL" });
    expect(pickInto({}, doc, { organisationProfile: { sortCodeLegacy: true } })).toEqual({ organisationProfile: { sortCodeLegacy: "UNKNOWN-ORG-PROFILE" } });
  });
});

describe("internal creditor profile (O6 / N3): p5-svc-sig/1, caller profile-service", () => {
  const { canonicalString, signCanonical, sha256Hex } = require("../services/serviceSignatureVerify");
  const KID = "pr-2026-11";
  const KEY = "TEST-ONLY-p5-svc-sig-vector-secret-profile-user-0001";
  const url = `/internal/tenants/${A}/creditor-profile`;
  const enforce = (extra = {}) => ({ TENANT_CREDITOR_SERVICE_AUTH_MODE: "enforce", SVC_SIGNING_KEYS_PROFILE_SERVICE: `${KID}:${KEY}`, ...extra });
  let nonceSeq = 0;
  function signed({ target = url, tenant = A, caller = "profile-service", kid = KID, key = KEY, ts = Math.floor(Date.now() / 1000), nonce, method = "GET" } = {}) {
    const n = nonce || `bm9uY2UtY3JlZGl0b3ItdGVzdC0${String(++nonceSeq).padStart(4, "0")}`;
    const c = canonicalString({ caller, kid, method, target, tenant, idem: "", bodySha256: sha256Hex(Buffer.alloc(0)), ts: String(ts), nonce: n });
    return { "x-tenant-id": tenant, "x-svc-version": "1", "x-svc-caller": caller, "x-svc-kid": kid, "x-svc-ts": String(ts), "x-svc-nonce": n, "x-svc-sig": signCanonical(key, c) };
  }
  beforeEach(() => mockNonces.clear());

  test("mode off (default) = 503 kill switch, even with a valid signature; nothing read", async () => {
    mockSignDeps.env = { SVC_SIGNING_KEYS_PROFILE_SERVICE: `${KID}:${KEY}` };
    const r = await call("GET", url, signed());
    expect([r.status, r.body.code]).toEqual([503, "CREDITOR_PROFILE_LOOKUP_DISABLED"]);
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test.each(["report", "enforce"])("mode %s: a valid signature reads the SIGNED tenant; allow-listed creditor fields only", async (mode) => {
    mockSignDeps.env = enforce({ TENANT_CREDITOR_SERVICE_AUTH_MODE: mode });
    const r = await call("GET", url, signed());
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual(["branding", "code", "name", "organisationProfile", "tenantId"]);
    expect(r.body.data.organisationProfile).toMatchObject({ iban: "IE29AIBK93115212345678", bic: "AIBKIE2DXXX", bankName: "Test Bank", sepaOriginatorIdentificationNumber: "IE00ZZZ000000", legalName: "Org A Ltd" });
    expect(r.raw).not.toMatch(/passwordPolicy|authenticationConnections|enterprise|creator|updater|UNKNOWN-/);
  });

  test.each(["report", "enforce"])("mode %s still REQUIRES a valid signature: missing / bad sig / unknown kid / stale / wrong caller / replay", async (mode) => {
    mockSignDeps.env = enforce({ TENANT_CREDITOR_SERVICE_AUTH_MODE: mode });
    const code = async (h) => { const r = await call("GET", url, h); return [r.status, r.body && r.body.code]; };
    expect(await code({ "x-tenant-id": A })).toEqual([401, "SERVICE_AUTH_REQUIRED"]);
    expect(await code({ ...signed(), "x-svc-sig": signed({ key: `${KEY}-other-key-material` })["x-svc-sig"] })).toEqual([401, "SERVICE_AUTH_INVALID"]);
    expect(await code(signed({ kid: "pr-unknown" }))).toEqual([401, "SERVICE_AUTH_UNKNOWN_KID"]);
    expect(await code(signed({ ts: Math.floor(Date.now() / 1000) - 120 }))).toEqual([401, "SERVICE_AUTH_STALE"]);
    expect(await code(signed({ caller: "communication-service" }))).toEqual([403, "SERVICE_NOT_ALLOWED"]); // not allowed yet
    expect(await code(signed({ caller: "account-service" }))).toEqual([403, "SERVICE_NOT_ALLOWED"]);
    const once = signed();
    expect((await code(once))[0]).toBe(200);
    expect(await code(once)).toEqual([401, "SERVICE_AUTH_REPLAY"]);
    expect(Tenant.findOne).toHaveBeenCalledTimes(1);
  });

  test("the signature binds the exact path and x-tenant-id: re-targeting or re-tenanting fails", async () => {
    mockSignDeps.env = enforce();
    // signed for tenant A, sent with x-tenant-id B
    expect((await call("GET", url, { ...signed(), "x-tenant-id": OTHER })).body.code).toBe("SERVICE_AUTH_INVALID");
    // signed for A's path, sent to B's path
    expect((await call("GET", `/internal/tenants/${OTHER}/creditor-profile`, signed())).body.code).toBe("SERVICE_AUTH_INVALID");
    // a genuine signature for path B with x-tenant-id A: the handler refuses (path tenant != signed tenant)
    const r = await call("GET", `/internal/tenants/${OTHER}/creditor-profile`, signed({ target: `/internal/tenants/${OTHER}/creditor-profile`, tenant: A }));
    expect([r.status, r.body.code]).toEqual([403, "TENANT_MISMATCH"]);
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test.each(["off", "report", "enforce"])("mode %s: ANY user / gateway identity header -> 404, even with a valid signature", async (mode) => {
    mockSignDeps.env = enforce({ TENANT_CREDITOR_SERVICE_AUTH_MODE: mode });
    for (const extra of [{ authorization: "Bearer user" }, { "x-jwt-verified": "true" }, { "x-auth-source": "gateway" }, { "x-user-id": "u" }, { "x-gateway-signature": "g" }, { "x-service-secret": "s" }]) {
      const r = await call("GET", url, { ...signed(), ...extra });
      expect([Object.keys(extra)[0], r.status]).toEqual([Object.keys(extra)[0], 404]);
    }
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test("the shared secret mechanism is gone", () => {
    const src = ["controllers/internalTenantCreditorProfile.controller.js", "routes/internalTenantCreditorProfile.routes.js", "env.development.template"]
      .map((f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8")).join("\n");
    expect(src).not.toMatch(/INTERNAL_TENANT_PROFILE_SECRET|x-service-secret.*===|requireTenantProfileSecret/);
  });

  test("mounted outside /api (the gateway proxies only /user-service/{api,auth,pkce}) - never on an /api router", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "index.js"), "utf8");
    expect(src).toMatch(/router\.use\("\/internal", require\("\.\/internalTenantCreditorProfile\.routes"\)\)/);
    expect(src).not.toMatch(/router\.use\("\/api", require\("\.\/internalTenantCreditorProfile\.routes"\)\)/);
  });

  test("creditor view is built from allow-lists (unknown organisation-profile fields dropped)", () => {
    expect(toCreditorProfileView({ ...mockTenantDoc(), organisationProfile: { iban: "X", internalNote: "y" } }).organisationProfile).toEqual({ iban: "X" });
  });
});
