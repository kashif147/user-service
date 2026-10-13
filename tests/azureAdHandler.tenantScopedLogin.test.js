/**
 * Tenant-scoped CRM (Entra ID) sign-in: the ProjectShell tenant the login was STARTED for (bound to
 * the OAuth state server-side, see tenantScopedLogin.flow.test.js) decides where the user is found
 * or just-in-time provisioned, even though MULTIAUTH and DEVTENANTB share one Entra directory, app
 * registration, issuer and audience.
 *
 * Runs the REAL AzureADHandler.findOrCreateUser and helpers/identityTenantResolution.js against
 * in-memory User/Tenant models honouring the unique {tenantId,userEmail} and
 * {tenantId,userMicrosoftId} indexes.
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
      r = { _id: `new-${mockStore.users.length + 1}`, roles: [] };
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
jest.mock("../helpers/roleAssignment", () => ({
  assignDefaultRole: async (u, type, t) => mockStore.calls.push(`defaultRole:${type}:${t}`),
}));
jest.mock("../helpers/oauthTokenStorage", () => ({ buildUserTokensSubdocument: () => ({ stored: true }) }));
jest.mock("../rabbitMQ/publishers/user.crm.publisher", () => ({
  publishCrmUserCreated: async () => mockStore.calls.push("publishCreated"),
  publishCrmUserUpdated: async () => mockStore.calls.push("publishUpdated"),
}));

const AzureADHandler = require("../handlers/azure.ad.handler");

const conn = (id, extra = {}) => ({
  _id: id, connectionType: "Entra ID (Azure AD)", issuerUrl: ISSUER, directoryId: DIR, isActive: true, ...extra,
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

describe("positive cases: same Entra directory, tenant chosen by the login context", () => {
  test("S1 User A through MULTIAUTH -> existing MULTIAUTH user, updated by _id", async () => {
    mockStore.users = [crmUser({ id: "a1", email: EMAIL_A, tenant: TENANT_A, oid: OID_A })];
    const u = await login(EMAIL_A, OID_A, ctxA);
    expect(u._id).toBe("a1");
    expect(String(u.tenantId)).toBe(TENANT_A);
    expect(mockStore.calls).toContain(`update:{"_id":"a1"}`);
  });

  test("S2 User B through DEVTENANTB, first login -> JIT user created ONLY in DEVTENANTB, keyed by oid", async () => {
    mockStore.users = [crmUser({ id: "a1", email: EMAIL_A, tenant: TENANT_A, oid: OID_A })];
    const u = await login(EMAIL_B, OID_B, ctxB);
    expect(String(u.tenantId)).toBe(TENANT_B);
    expect(u.userMicrosoftId).toBe(OID_B);
    expect(u.userEmail).toBe(EMAIL_B);
    expect(usersIn(TENANT_B)).toHaveLength(1);
    expect(usersIn(TENANT_A)).toHaveLength(1);
    expect(mockStore.calls).toEqual(expect.arrayContaining([`insert:${TENANT_B}`, `defaultRole:CRM:${TENANT_B}`, "publishCreated"]));
    expect(mockStore.calls).toContain(`update:${JSON.stringify({ tenantId: TENANT_B, userMicrosoftId: OID_B })}`);
  });

  test("S3 second login reuses the same DEVTENANTB user (no duplicate)", async () => {
    const first = await login(EMAIL_B, OID_B, ctxB);
    mockStore.calls = [];
    const second = await login(EMAIL_B, OID_B, ctxB);
    expect(second._id).toBe(first._id);
    expect(usersIn(TENANT_B)).toHaveLength(1);
    expect(mockStore.calls).not.toEqual(expect.arrayContaining([expect.stringMatching(/^insert/)]));
    expect(mockStore.calls).toContain("publishUpdated");
  });

  test("S4 a changed email/UPN on a later login still resolves by oid (email is profile data, not the key)", async () => {
    mockStore.users = [crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B })];
    const u = await login("renamed@creativelab147outlook.onmicrosoft.com", OID_B, ctxB);
    expect(u._id).toBe("b1");
    expect(u.userEmail).toBe("renamed@creativelab147outlook.onmicrosoft.com");
  });

  test("S5 the directory-derived profile.tenantId (A) is ignored when the login was started for B", async () => {
    const p = profile(EMAIL_B, OID_B);
    expect(p.tenantId).toBe(TENANT_A);
    const u = await AzureADHandler.findOrCreateUser(p, { access_token: "at" }, ctxB);
    expect(String(u.tenantId)).toBe(TENANT_B);
  });

  test("S6 pre-provisioned placeholder in the tenant (no real oid yet) is claimed by email, not duplicated", async () => {
    mockStore.users = [crmUser({ id: "b0", email: EMAIL_B, tenant: TENANT_B, oid: "pending-first-login-x", issuer: null })];
    const u = await login(EMAIL_B, OID_B, ctxB);
    expect(u._id).toBe("b0");
    expect(byId("b0").userMicrosoftId).toBe(OID_B);
    expect(usersIn(TENANT_B)).toHaveLength(1);
  });
});

describe("isolation: users are never read, moved or duplicated across tenants", () => {
  test("I1 User A signing in through DEVTENANTB does not touch the MULTIAUTH user; a separate DEVTENANTB user is created", async () => {
    mockStore.users = [crmUser({ id: "a1", email: EMAIL_A, tenant: TENANT_A, oid: OID_A })];
    const u = await login(EMAIL_A, OID_A, ctxB);
    expect(String(u.tenantId)).toBe(TENANT_B);
    expect(u._id).not.toBe("a1");
    expect(byId("a1").tenantId).toBe(TENANT_A);
    expect(mockStore.calls).not.toContain(`update:{"_id":"a1"}`);
  });

  test("I2 DEVTENANTB with autoProvisionUsers:false -> 403, nothing written anywhere", async () => {
    mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { autoProvisionUsers: false })];
    mockStore.users = [crmUser({ id: "a1", email: EMAIL_B, tenant: TENANT_A, oid: OID_B })];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ name: "AppError", status: 403 });
    expect(mockStore.calls).toEqual([]);
    expect(byId("a1").tenantId).toBe(TENANT_A); // the wrongly-placed A record is not silently moved
  });

  test("I3 the old defect: B's identity existing in MULTIAUTH does NOT make a DEVTENANTB login land in MULTIAUTH", async () => {
    mockStore.users = [crmUser({ id: "dup", email: EMAIL_B, tenant: TENANT_A, oid: OID_B })];
    const u = await login(EMAIL_B, OID_B, ctxB);
    expect(String(u.tenantId)).toBe(TENANT_B);
    expect(u._id).not.toBe("dup");
    expect(byId("dup").tenantId).toBe(TENANT_A);
  });

  test("I4 an email match in the tenant carrying a DIFFERENT real oid is refused, never taken over", async () => {
    mockStore.users = [crmUser({ id: "b9", email: EMAIL_B, tenant: TENANT_B, oid: "some-other-oid" })];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403 });
    expect(byId("b9").userMicrosoftId).toBe("some-other-oid");
    expect(mockStore.calls).toEqual([]);
  });

  test("I5 an oid match whose record was issued by another directory is refused", async () => {
    mockStore.users = [crmUser({ id: "b8", email: EMAIL_B, tenant: TENANT_B, oid: OID_B, issuer: `https://login.microsoftonline.com/${OTHER_DIR}/v2.0` })];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403 });
    expect(mockStore.calls).toEqual([]);
  });
});

describe("connection validation against the stored login context", () => {
  test("V1 token tid differs from the tenant connection's directory -> 403", async () => {
    mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { directoryId: OTHER_DIR })];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403 });
    expect(mockStore.calls).toEqual([]);
  });

  test("V2 connection disconnected between start and callback -> 403", async () => {
    mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { isActive: false })];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403 });
  });

  test("V3 a connection id from ANOTHER tenant cannot be paired with this tenant", async () => {
    await expect(login(EMAIL_B, OID_B, { tenantId: TENANT_B, connectionId: CONN_A })).rejects.toMatchObject({ status: 403 });
    expect(mockStore.calls).toEqual([]);
  });

  test("V4 tenant deactivated -> 403", async () => {
    mockStore.tenants[1].isActive = false;
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403 });
  });

  test("V5 token without an oid -> 403", async () => {
    await expect(login(EMAIL_B, null, ctxB)).rejects.toMatchObject({ status: 403 });
  });
});

describe("logins without a tenant context keep the directory-wide fallback", () => {
  test("F1 existing DEVTENANTB user still resolves to DEVTENANTB without ?tenant", async () => {
    mockStore.users = [crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B })];
    const u = await login(EMAIL_B, OID_B, null);
    expect(String(u.tenantId)).toBe(TENANT_B);
  });

  test("F2 new identity with TWO auto-provisioning tenants on the directory -> 403 (must use a tenant-scoped login)", async () => {
    await expect(login(EMAIL_B, OID_B, null)).rejects.toMatchObject({ status: 403 });
    expect(mockStore.calls).toEqual([]);
  });

  test("F3 identity present in both tenants -> fallback refuses, tenant-scoped login picks the right one", async () => {
    mockStore.users = [
      crmUser({ id: "a1", email: EMAIL_A, tenant: TENANT_A, oid: OID_A }),
      crmUser({ id: "b1", email: EMAIL_A, tenant: TENANT_B, oid: OID_A }),
    ];
    await expect(login(EMAIL_A, OID_A, null)).rejects.toMatchObject({ status: 403 });
    expect((await login(EMAIL_A, OID_A, ctxB))._id).toBe("b1");
    expect((await login(EMAIL_A, OID_A, ctxA))._id).toBe("a1");
  });
});
