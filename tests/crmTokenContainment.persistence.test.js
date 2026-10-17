/**
 * CRM Microsoft-token containment - persistence. A CRM sign-in stores NO Microsoft OAuth credential
 * (ID token, refresh token, expiries) on the user, clears what an earlier login stored, and keeps
 * the Entra identity linkage (oid, issuer), tenant and roles. Uses the REAL oauthTokenStorage
 * helper and the same in-memory User/Tenant models as azureAdHandler.tenantScopedLogin.test.js.
 * B2C (portal) persistence is unchanged.
 */
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa"; // MULTIAUTH
const TENANT_B = "cccccccccccccccccccccccc"; // DEVTENANTB
const CONN_A = "c0000000000000000000000a";
const CONN_B = "c0000000000000000000000b";
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const OTHER_DIR = "11111111-2222-3333-4444-555555555555";
const ISSUER = `https://login.microsoftonline.com/${DIR}/v2.0`;
const OID_A = "633c82e1-0377-4c69-bc61-b4f03992a4a7";
const OID_B = "6b217f09-5e3a-424f-9329-74e68fe05299";
const EMAIL_A = "test@creativelab147outlook.onmicrosoft.com";
const EMAIL_B = "tenantb.tester@creativelab147outlook.onmicrosoft.com";

const mockStore = { users: [], calls: [], tenants: [] };
const mockClone = (o) => JSON.parse(JSON.stringify(o));
const mockMatches = (u, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(u[k]));
    if (v && typeof v === "object" && "$nin" in v) return !v.$nin.map(String).includes(String(u[k]));
    if (v && typeof v === "object" && "$ne" in v) return u[k] !== v.$ne;
    return String(u[k]) === String(v);
  });
const mockDoc = (u) => Object.assign(u, { save: async function save() { mockStore.calls.push(`save:${u._id}`); return this; } });
const mockDup = () => Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });

jest.mock("../models/user.model", () => ({
  find: (q) => ({ lean: async () => mockStore.users.filter((u) => mockMatches(u, q)).map(mockClone) }),
  findOne: (q) => {
    const r = mockStore.users.find((u) => mockMatches(u, q));
    const p = Promise.resolve(r ? mockDoc(r) : null);
    p.lean = async () => (r ? mockClone(r) : null);
    return p;
  },
  findOneAndUpdate: async (q, upd, opts) => {
    mockStore.calls.push(`update:${JSON.stringify(q)}`);
    let r = mockStore.users.find((u) => mockMatches(u, q));
    const set = upd.$set || {};
    if (!r && !opts.upsert) return null;
    if (!r) {
      const t = String(set.tenantId);
      if (mockStore.users.some((u) => String(u.tenantId) === t && (u.userEmail === set.userEmail || u.userMicrosoftId === set.userMicrosoftId))) {
        throw mockDup();
      }
      r = { _id: `new-${mockStore.users.length + 1}`, roles: [], ...mockClone(upd.$setOnInsert || {}) };
      mockStore.users.push(r);
      mockStore.calls.push(`insert:${t}`);
    }
    Object.assign(r, mockClone(set));
    return mockDoc(r);
  },
}));
jest.mock("../models/tenant.model", () => ({
  exists: async (q) => (mockStore.tenants.some((t) => t._id === String(q._id)) ? { _id: q._id } : null),
  find: (q) => {
    const m = q.authenticationConnections.$elemMatch;
    const rows = mockStore.tenants.filter((t) =>
      t.authenticationConnections.some((c) => c.connectionType === m.connectionType && c.directoryId === m.directoryId && c.isActive === m.isActive),
    );
    return { select: () => ({ lean: async () => mockClone(rows) }) };
  },
  findOne: (q) => {
    const r = mockStore.tenants.find((t) => t._id === String(q._id) && t.isActive !== false);
    return { select: () => ({ lean: async () => (r ? mockClone(r) : null) }) };
  },
}));
jest.mock("../models/role.model", () => ({}));
// Provisioning rules are tested for real in phase2.connectionDefaultRole.test.js; here: a user has
// access when it holds any role, and JIT gets the connection's configured defaultRoleId.
jest.mock("../helpers/connectionDefaultRole", () => {
  class DefaultRoleError extends Error {}
  return {
    DefaultRoleError,
    isAutomatic: (c) => c?.autoProvisionUsers === true,
    hasActiveRoleInTenant: async (u) => (u.roles || []).length > 0,
    resolveJitDefaultRoleId: async ({ tenantId, connection }) => {
      mockStore.calls.push(`defaultRole:${tenantId}`);
      // Same contract as the real helper (Phase 2b): no explicit defaultRoleId -> NOT_CONFIGURED,
      // never a fallback role; otherwise the configured role.
      if (!connection?.defaultRoleId) throw new DefaultRoleError("NOT_CONFIGURED");
      if (connection.defaultRoleId === "broken") throw new DefaultRoleError("INACTIVE");
      return connection.defaultRoleId;
    },
  };
});
jest.mock("../rabbitMQ/publishers/user.crm.publisher", () => ({
  publishCrmUserCreated: async () => mockStore.calls.push("publishCreated"),
  publishCrmUserUpdated: async () => mockStore.calls.push("publishUpdated"),
}));

const AzureADHandler = require("../handlers/azure.ad.handler");

const conn = (id, extra = {}) => ({
  _id: id, connectionType: "Entra ID (Azure AD)", issuerUrl: ISSUER, directoryId: DIR, isActive: true, autoProvisionUsers: true, defaultRoleId: "role-default", ...extra,
});
// decodeIdToken's profile: tenantId is whatever tenant the directory lookup found first (A). It
// must never decide the application tenant.
const profile = (email, oid, dir = DIR) => ({
  userEmail: email, userFirstName: "F", userLastName: "L", userFullName: "F L",
  userMicrosoftId: oid, userSubject: `sub-${oid}`, userIssuer: `https://login.microsoftonline.com/${dir}/v2.0`,
  tenantId: TENANT_A, microsoftDirectoryId: dir,
});
const crmUser = (o) => ({
  _id: o.id, userEmail: o.email, tenantId: o.tenant, userType: "CRM", userMicrosoftId: o.oid,
  userIssuer: o.issuer === undefined ? ISSUER : o.issuer, roles: ["r"],
});
const ctxA = { tenantId: TENANT_A, connectionId: CONN_A };
const ctxB = { tenantId: TENANT_B, connectionId: CONN_B };
const login = (email, oid, ctx, dir) => AzureADHandler.findOrCreateUser(profile(email, oid, dir), { access_token: "at" }, ctx);
const byId = (id) => mockStore.users.find((u) => u._id === id);
const usersIn = (t) => mockStore.users.filter((u) => u.tenantId === t);

beforeEach(() => {
  mockStore.users = [];
  mockStore.calls = [];
  mockStore.tenants = [
    { _id: TENANT_A, isActive: true, authenticationConnections: [conn(CONN_A)] },
    { _id: TENANT_B, isActive: true, authenticationConnections: [conn(CONN_B)] },
  ];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const MS_TOKENS = { id_token: "MS-ID-TOKEN", access_token: "MS-ACCESS-TOKEN", refresh_token: "MS-REFRESH-TOKEN", expires_in: 3600, refresh_token_expires_in: 7776000 };
const NO_TOKENS = { id_token: null, refresh_token: null, id_token_expires_in: null, refresh_token_expires_in: null, refresh_token_expires_at: null };
const signIn = (email, oid, ctx) => AzureADHandler.findOrCreateUser(profile(email, oid), MS_TOKENS, ctx);

describe("CRM sign-in persists no Microsoft OAuth credentials", () => {
  test("existing user with legacy stored tokens: cleared to nulls; oid, issuer, tenant, roles kept", async () => {
    mockStore.users = [{ ...crmUser({ id: "a1", email: EMAIL_A, tenant: TENANT_A, oid: OID_A }), tokens: { id_token: "OLD-ID", refresh_token: "OLD-RT", refresh_token_expires_at: null } }];
    const u = await signIn(EMAIL_A, OID_A, ctxA);
    expect(u._id).toBe("a1"); // existing user reused
    expect(byId("a1").tokens).toEqual(NO_TOKENS);
    expect(byId("a1")).toMatchObject({ userMicrosoftId: OID_A, userIssuer: ISSUER, tenantId: TENANT_A, roles: ["r"], userType: "CRM" });
    expect(JSON.stringify(mockStore.users)).not.toMatch(/MS-ID-TOKEN|MS-ACCESS-TOKEN|MS-REFRESH-TOKEN|OLD-RT|OLD-ID/);
  });

  test("JIT-provisioned user (automatic connection): no token material stored, default role as before", async () => {
    const u = await signIn("new.staff@x.org", "11111111-aaaa-bbbb-cccc-222222222222", ctxB);
    const stored = byId(u._id);
    expect(stored.tokens).toEqual(NO_TOKENS);
    expect(stored).toMatchObject({ tenantId: TENANT_B, userMicrosoftId: "11111111-aaaa-bbbb-cccc-222222222222", roles: ["role-default"] });
    expect(mockStore.calls).toContain(`defaultRole:${TENANT_B}`);
  });

  test("no-code (legacy) CRM path: same, nothing stored", async () => {
    mockStore.users = [crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B })];
    await AzureADHandler.findOrCreateUser(profile(EMAIL_B, OID_B), MS_TOKENS, null);
    expect(byId("b1").tokens).toEqual(NO_TOKENS);
    expect(byId("b1").tenantId).toBe(TENANT_B);
  });

  test("no CRM code path writes the Microsoft token response (incl. the duplicate-key retry)", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "handlers", "azure.ad.handler.js"), "utf8");
    expect(src).not.toMatch(/buildUserTokensSubdocument\(tokens\)/);
    expect(src.match(/buildUserTokensSubdocument\(null\)/g)).toHaveLength(2);
  });
});

describe("B2C (portal) persistence unchanged", () => {
  test("the B2C handler still stores its Microsoft token response; the helper still keeps the refresh token", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "handlers", "b2c.users.handler.js"), "utf8");
    expect(src).toMatch(/tokens: buildUserTokensSubdocument\(tokens\)/);
    const { buildUserTokensSubdocument } = jest.requireActual("../helpers/oauthTokenStorage");
    expect(buildUserTokensSubdocument(MS_TOKENS)).toMatchObject({ id_token: "MS-ID-TOKEN", refresh_token: "MS-REFRESH-TOKEN", refresh_token_expires_in: 7776000 });
  });
});
