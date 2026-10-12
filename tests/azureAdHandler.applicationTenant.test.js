/**
 * Phase 2E — CRM (Entra ID) sign-in: the ProjectShell application tenant comes from the
 * ProjectShell user record, not from the Entra directory.
 *
 * decodeIdToken still validates the trusted directory (tid === AZURE_AD_TENANT_ID, covered by
 * azureAdHandler.decodeIdToken.test.js). Several ProjectShell tenants may trust that one
 * directory; findOrCreateUser must then resolve the user's own tenant.
 *
 * Before: the tenant was whichever Tenant listed the directory, and ANY existing user found by
 * email alone was re-tenanted into it on login (a Tenant-B user would be moved to Tenant A).
 *
 * Runs the REAL AzureADHandler.findOrCreateUser and helpers/identityTenantResolution.js against
 * in-memory User/Tenant models honouring the unique {tenantId,userEmail} index.
 */
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const OTHER_TENANT = "bbbbbbbbbbbbbbbbbbbbbbbb"; // real tenant that does NOT trust the directory
const DIR = "entra-dir";

const mockStore = { users: [], calls: [], trustingTenants: [], realTenants: [] };
const mockClone = (o) => JSON.parse(JSON.stringify(o));
const mockMatches = (u, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(u[k]));
    if (v && typeof v === "object" && "$nin" in v) return !v.$nin.map(String).includes(String(u[k]));
    return String(u[k]) === String(v);
  });
const mockDoc = (u) => Object.assign(u, { save: async function save() { mockStore.calls.push(`save:${u._id}`); return this; } });

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
      if (mockStore.users.some((u) => u.userEmail === set.userEmail && String(u.tenantId) === String(set.tenantId))) {
        const e = new Error("E11000 duplicate key error");
        e.code = 11000;
        throw e;
      }
      r = { _id: `new-${set.userEmail}`, roles: [] };
      mockStore.users.push(r);
      mockStore.calls.push("insert");
    }
    Object.assign(r, mockClone(set));
    return mockDoc(r);
  },
}));
jest.mock("../models/tenant.model", () => ({
  exists: async (q) => (mockStore.realTenants.includes(String(q._id)) ? { _id: q._id } : null),
  find: (q) => {
    const m = q.authenticationConnections.$elemMatch;
    const rows = mockStore.trustingTenants.filter((t) =>
      t.authenticationConnections.some((c) => c.connectionType === m.connectionType && c.directoryId === m.directoryId && c.isActive === m.isActive),
    );
    return { select: () => ({ lean: async () => mockClone(rows) }) };
  },
}));
jest.mock("../models/role.model", () => ({}));
jest.mock("../helpers/roleAssignment", () => ({
  assignDefaultRole: async (u, type, t) => mockStore.calls.push(`defaultRole:${type}:${t}`),
}));
jest.mock("../helpers/oauthTokenStorage", () => ({ buildUserTokensSubdocument: () => ({ stored: true }) }));
jest.mock("../rabbitMQ/publishers/user.crm.publisher", () => ({
  publishCrmUserCreated: async () => mockStore.calls.push("publishCreated"),
  publishCrmUserUpdated: async () => mockStore.calls.push("publishUpdated"),
}));

const AzureADHandler = require("../handlers/azure.ad.handler");

const conn = (autoProvisionUsers) => ({
  connectionType: "Entra ID (Azure AD)", directoryId: DIR, isActive: true,
  ...(autoProvisionUsers === undefined ? {} : { autoProvisionUsers }),
});
// What decodeIdToken returns after validating the trusted directory: tenantId is the
// directory's (first) tenant and must NOT be taken as the application tenant.
const profile = (email, oid) => ({
  userEmail: email, userFirstName: "F", userLastName: "L", userFullName: "F L",
  userMicrosoftId: oid, userSubject: `sub-${oid}`, tenantId: TENANT_A, microsoftDirectoryId: DIR,
});
const crmUser = (o) => ({ _id: o.id, userEmail: o.email, tenantId: o.tenant, userType: o.type || "CRM", userMicrosoftId: o.oid, roles: o.roles || ["r"] });
const byId = (id) => mockStore.users.find((u) => u._id === id);
const login = (email, oid) => AzureADHandler.findOrCreateUser(profile(email, oid), { access_token: "at", refresh_token: "rt" });

beforeEach(() => {
  mockStore.users = [];
  mockStore.calls = [];
  mockStore.realTenants = [TENANT_A, TENANT_B, OTHER_TENANT];
  mockStore.trustingTenants = [
    { _id: TENANT_A, authenticationConnections: [conn()] },
    { _id: TENANT_B, authenticationConnections: [conn(false)] },
  ];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("CRM application tenant comes from the ProjectShell user, not the Entra directory", () => {
  test("C1 existing Tenant-A user -> Tenant A, updated by _id", async () => {
    mockStore.users = [crmUser({ id: "a1", email: "a@x.com", tenant: TENANT_A, oid: "oid-a" })];
    const u = await login("a@x.com", "oid-a");
    expect(String(u.tenantId)).toBe(TENANT_A);
    expect(mockStore.calls).toContain(`update:{"_id":"a1"}`);
  });

  test("C2 user provisioned in Tenant B (same directory) -> Tenant B; tenant never rewritten to A", async () => {
    mockStore.users = [crmUser({ id: "b1", email: "b.staff@x.com", tenant: TENANT_B, oid: "oid-b" })];
    const u = await login("b.staff@x.com", "oid-b");
    expect(String(u.tenantId)).toBe(TENANT_B);
    expect(byId("b1").tenantId).toBe(TENANT_B);
    expect(mockStore.users).toHaveLength(1);
  });

  test("C3 pre-provisioned Tenant-B user without an oid yet is matched by email -> Tenant B", async () => {
    mockStore.users = [crmUser({ id: "b2", email: "b.new@x.com", tenant: TENANT_B, oid: null })];
    const u = await login("b.new@x.com", "oid-first-login");
    expect(String(u.tenantId)).toBe(TENANT_B);
    expect(byId("b2").userMicrosoftId).toBe("oid-first-login");
  });

  test("C4 new identity -> provisioned into the auto-provisioning tenant (A) with its default role", async () => {
    const u = await login("new@x.com", "oid-new");
    expect(String(u.tenantId)).toBe(TENANT_A);
    expect(mockStore.calls).toEqual(expect.arrayContaining(["insert", `defaultRole:CRM:${TENANT_A}`, "publishCreated"]));
  });

  test("C5 same email in a REAL tenant that does not trust the directory is NOT moved (old code re-tenanted it)", async () => {
    mockStore.users = [crmUser({ id: "o1", email: "o@x.com", tenant: OTHER_TENANT, oid: "oid-o" })];
    const u = await login("o@x.com", "oid-o");
    expect(byId("o1").tenantId).toBe(OTHER_TENANT);
    expect(String(u.tenantId)).toBe(TENANT_A);
    expect(u._id).not.toBe("o1");
  });

  test("C6 legacy user whose tenantId is not a real Tenant is still migrated into the resolved tenant", async () => {
    mockStore.users = [crmUser({ id: "l1", email: "legacy@x.com", tenant: "raw-directory-guid", oid: "oid-l" })];
    const u = await login("legacy@x.com", "oid-l");
    expect(u._id).toBe("l1");
    expect(String(byId("l1").tenantId)).toBe(TENANT_A);
  });

  test("C7 identity provisioned in both A and B -> 403, nothing written", async () => {
    mockStore.users = [
      crmUser({ id: "x1", email: "both@x.com", tenant: TENANT_A, oid: "oid-both" }),
      crmUser({ id: "x2", email: "both@x.com", tenant: TENANT_B, oid: "oid-both" }),
    ];
    await expect(login("both@x.com", "oid-both")).rejects.toMatchObject({ name: "AppError", status: 403 });
    expect(mockStore.calls).toEqual([]);
  });

  test("C8 no auto-provisioning tenant -> new identity refused (403), nothing inserted", async () => {
    mockStore.trustingTenants[0].authenticationConnections = [conn(false)];
    await expect(login("nobody@x.com", "oid-nobody")).rejects.toMatchObject({ name: "AppError", status: 403 });
    expect(mockStore.calls).toEqual([]);
  });

  test("C9 directory trusted by no tenant -> 403", async () => {
    mockStore.trustingTenants = [];
    await expect(login("a@x.com", "oid-a")).rejects.toMatchObject({ name: "AppError", status: 403 });
  });

  test("C10 the token's directory-derived tenantId in the profile is never used as the application tenant", async () => {
    mockStore.users = [crmUser({ id: "b3", email: "b3@x.com", tenant: TENANT_B, oid: "oid-b3" })];
    const p = profile("b3@x.com", "oid-b3");
    p.tenantId = TENANT_A; // what decodeIdToken returns for the shared directory
    const u = await AzureADHandler.findOrCreateUser(p, { access_token: "at" });
    expect(String(u.tenantId)).toBe(TENANT_B);
  });
});
