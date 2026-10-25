/**
 * CRM (Entra ID) sign-in never re-binds a stored Microsoft id and never signs in a non-CRM user,
 * on BOTH entry paths: with an organisation code (tenant-scoped, resolveTenantScopedUser) and
 * without one (directory fallback, resolveApplicationTenant, existing users only).
 *
 *  - exact oid match (CRM user)                      -> continue
 *  - email match, CRM user without a real oid yet    -> linked once (atomically)
 *  - email match, same stored oid                    -> continue, no re-link
 *  - email match, CRM user bound to a DIFFERENT oid  -> 403, no write (MICROSOFT_ID_MISMATCH)
 *  - any match on a non-CRM (PORTAL) user            -> 403, no write (USER_TYPE_MISMATCH)
 *  - ambiguous                                       -> 403
 * The update filter re-checks the approved identity atomically, so a concurrent link/re-bind after
 * the check cannot be overwritten; the E11000 retry adopts only a CRM record already bound to the
 * incoming oid.
 *
 * Runs the REAL AzureADHandler.findOrCreateUser and helpers/identityTenantResolution.js against
 * in-memory User/Tenant models honouring the unique {tenantId,userEmail} and
 * {tenantId,userMicrosoftId} indexes.
 */
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const CONN_A = "c0000000000000000000000a";
const CONN_B = "c0000000000000000000000b";
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const ISSUER = `https://login.microsoftonline.com/${DIR}/v2.0`;
const OID_1 = "11111111-aaaa-4aaa-8aaa-000000000001";
const OID_2 = "22222222-bbbb-4bbb-8bbb-000000000002";
const OID_3 = "33333333-cccc-4ccc-8ccc-000000000003";
const EMAIL = "secret.staff@example.org";
const LAST_LOGIN = "2026-01-01T00:00:00.000Z";

const mockStore = { users: [], calls: [], tenants: [], beforeUpdate: null };
const mockClone = (o) => JSON.parse(JSON.stringify(o));
const mockMatches = (u, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(u[k] ?? null));
    if (v && typeof v === "object" && "$ne" in v) return u[k] !== v.$ne;
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
    if (mockStore.beforeUpdate) {
      const hook = mockStore.beforeUpdate;
      mockStore.beforeUpdate = null;
      hook(); // simulates a concurrent request landing between the check and the write
    }
    mockStore.calls.push(`update:${JSON.stringify(q)}`);
    let r = mockStore.users.find((u) => mockMatches(u, q));
    const set = upd.$set || {};
    if (!r && !opts.upsert) return null;
    if (!r) {
      const t = String(set.tenantId);
      if (mockStore.users.some((u) => String(u.tenantId) === t && (u.userEmail === set.userEmail || u.userMicrosoftId === set.userMicrosoftId))) {
        throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
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
jest.mock("../helpers/connectionDefaultRole", () => {
  class DefaultRoleError extends Error {}
  return {
    DefaultRoleError,
    isAutomatic: (c) => c?.autoProvisionUsers === true,
    hasActiveRoleInTenant: async (u) => (u.roles || []).length > 0,
    resolveJitDefaultRoleId: async ({ connection }) => {
      if (!connection?.defaultRoleId) throw new DefaultRoleError("NOT_CONFIGURED");
      return connection.defaultRoleId;
    },
  };
});
jest.mock("../helpers/oauthTokenStorage", () => ({ buildUserTokensSubdocument: () => ({ stored: false }) }));
jest.mock("../rabbitMQ/publishers/user.crm.publisher", () => ({
  publishCrmUserCreated: async () => mockStore.calls.push("publishCreated"),
  publishCrmUserUpdated: async () => mockStore.calls.push("publishUpdated"),
}));

const AzureADHandler = require("../handlers/azure.ad.handler");

const conn = (id) => ({
  _id: id, connectionType: "Entra ID (Azure AD)", issuerUrl: ISSUER, directoryId: DIR, isActive: true,
  autoProvisionUsers: true, defaultRoleId: "role-default",
});
const profile = (oid, email = EMAIL) => ({
  userEmail: email, userFirstName: "F", userLastName: "L", userFullName: "F L",
  userMicrosoftId: oid, userSubject: `sub-${oid}`, userIssuer: ISSUER, tenantId: TENANT_A, microsoftDirectoryId: DIR,
});
const user = (o) => ({
  _id: o.id, userEmail: o.email || EMAIL, tenantId: o.tenant || TENANT_A, userType: o.type || "CRM",
  userMicrosoftId: o.oid === undefined ? OID_1 : o.oid, userIssuer: ISSUER, userAuthProvider: o.type === "PORTAL" ? "microsoft" : "azure-ad",
  roles: o.roles || ["role-x"], isActive: true, userLastLogin: LAST_LOGIN,
});
const byId = (id) => mockStore.users.find((u) => u._id === id);
const snap = (id) => mockClone(byId(id)); // data only (the mock attaches save())
const writes = () => mockStore.calls.filter((c) => /^(update|insert|save|publish)/.test(c));
const logged = () =>
  [console.log, console.warn, console.error]
    .flatMap((fn) => fn.mock.calls)
    .map((a) => a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "))
    .join("\n");
const denials = () => console.warn.mock.calls.filter((c) => c[0] === "Azure AD login denied:").map((c) => c[1].reason);

beforeEach(() => {
  mockStore.users = [];
  mockStore.calls = [];
  mockStore.beforeUpdate = null;
  mockStore.tenants = [
    { _id: TENANT_A, isActive: true, authenticationConnections: [conn(CONN_A)] },
    { _id: TENANT_B, isActive: true, authenticationConnections: [conn(CONN_B)] },
  ];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe.each([
  ["with organisation code (tenant-scoped)", { tenantId: TENANT_A, connectionId: CONN_A }],
  ["without organisation code (directory fallback)", null],
])("CRM identity binding - %s", (_mode, ctx) => {
  const login = (oid, email) => AzureADHandler.findOrCreateUser(profile(oid, email), { access_token: "at" }, ctx);
  const expectUntouched = (id, before) => {
    expect(snap(id)).toEqual(before);
    expect(writes()).toEqual([]);
  };

  test("exact oid match on a CRM user -> signs in, updated by _id with the identity guard", async () => {
    mockStore.users = [user({ id: "u1" })];
    const u = await login(OID_1);
    expect(u._id).toBe("u1");
    expect(byId("u1").userMicrosoftId).toBe(OID_1);
    expect(mockStore.calls).toContain(`update:{"_id":"u1","isActive":{"$ne":false},"userType":"CRM","userMicrosoftId":"${OID_1}"}`);
    expect(mockStore.users).toHaveLength(1);
  });

  test("email match carrying the same stored oid (changed email elsewhere irrelevant) -> continues, no re-link", async () => {
    mockStore.users = [user({ id: "u1" })];
    await login(OID_1);
    await login(OID_1);
    expect(byId("u1").userMicrosoftId).toBe(OID_1);
    expect(denials()).toEqual([]);
    expect(mockStore.users).toHaveLength(1);
  });

  test.each([["null", null], ["empty", ""], ["placeholder", "pending-first-login-abc"]])(
    "unbound CRM user (%s oid) is linked once by email; a later different oid is refused",
    async (_l, stored) => {
      mockStore.users = [user({ id: "u1", oid: stored })];
      const u = await login(OID_2);
      expect(u._id).toBe("u1");
      expect(byId("u1").userMicrosoftId).toBe(OID_2);
      const filter = mockStore.calls.find((c) => c.startsWith("update:"));
      expect(filter).toContain(`"userType":"CRM","userMicrosoftId":{"$in":`);
      const linked = mockClone(byId("u1"));
      mockStore.calls = [];
      await expect(login(OID_3)).rejects.toMatchObject({ name: "AppError", status: 403 });
      expectUntouched("u1", linked);
      expect(mockStore.users).toHaveLength(1);
    },
  );

  test("email match on a CRM user bound to a DIFFERENT oid -> 403, nothing written (oid, roles, tenant, last login)", async () => {
    mockStore.users = [user({ id: "u1" })];
    const before = mockClone(byId("u1"));
    await expect(login(OID_2)).rejects.toMatchObject({ name: "AppError", status: 403, message: "CRM sign-in is not available for this account" });
    expectUntouched("u1", before);
    expect(mockStore.users).toHaveLength(1);
    // organisation code: resolveTenantScopedUser already refuses it (IDENTITY_CONFLICT); no code: the handler's binding check
    expect(denials()).toEqual([ctx ? "IDENTITY_CONFLICT" : "MICROSOFT_ID_MISMATCH"]);
    const text = logged();
    for (const v of [EMAIL, OID_1, OID_2]) expect(text).not.toContain(v);
  });

  test.each([["bound", OID_1], ["unbound", null]])(
    "PORTAL user with the same email (%s) -> 403, stays PORTAL, no oid/role/tenant/last-login change",
    async (_l, stored) => {
      mockStore.users = [user({ id: "p1", type: "PORTAL", oid: stored, roles: ["non-member"] })];
      const before = mockClone(byId("p1"));
      await expect(login(OID_2)).rejects.toMatchObject({ name: "AppError", status: 403 });
      expectUntouched("p1", before);
      expect(byId("p1").userType).toBe("PORTAL");
      expect(denials()).toEqual([ctx && stored ? "IDENTITY_CONFLICT" : "USER_TYPE_MISMATCH"]);
      expect(mockStore.users).toHaveLength(1);
      expect(logged()).not.toContain(EMAIL);
    },
  );

  test("PORTAL user whose stored oid equals the incoming oid -> still 403 (CRM sign-in is for CRM users only)", async () => {
    mockStore.users = [user({ id: "p1", type: "PORTAL", oid: OID_1 })];
    const before = mockClone(byId("p1"));
    await expect(login(OID_1)).rejects.toMatchObject({ status: 403 });
    expectUntouched("p1", before);
    expect(denials()).toEqual(["USER_TYPE_MISMATCH"]);
  });

  test("ambiguous oid match -> 403, nothing written", async () => {
    mockStore.users = [user({ id: "u1" }), user({ id: "u2", email: "other@example.org", tenant: ctx ? TENANT_A : TENANT_B })];
    await expect(login(OID_1)).rejects.toMatchObject({ status: 403 });
    expect(writes()).toEqual([]);
  });

  test("concurrent re-bind after the check: the guarded write misses, 403, the concurrent value survives", async () => {
    mockStore.users = [user({ id: "u1", oid: null })];
    mockStore.beforeUpdate = () => { byId("u1").userMicrosoftId = OID_3; };
    await expect(login(OID_2)).rejects.toMatchObject({ status: 403 });
    expect(byId("u1").userMicrosoftId).toBe(OID_3);
    expect(denials()).toEqual(["USER_CHANGED_DURING_LOGIN"]);
    expect(mockStore.users).toHaveLength(1);
  });

  test("concurrent user-type change after the check: the guarded write misses, no conversion", async () => {
    mockStore.users = [user({ id: "u1", oid: OID_1 })];
    mockStore.beforeUpdate = () => { byId("u1").userType = "PORTAL"; };
    await expect(login(OID_1)).rejects.toMatchObject({ status: 403 });
    expect(byId("u1").userType).toBe("PORTAL");
  });

  test("two simultaneous first logins with different oids for one unbound user: exactly one wins", async () => {
    mockStore.users = [user({ id: "u1", oid: null })];
    const r = await Promise.allSettled([login(OID_2), login(OID_3)]);
    const ok = r.filter((x) => x.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(r.find((x) => x.status === "rejected").reason).toMatchObject({ status: 403 });
    expect([OID_2, OID_3]).toContain(byId("u1").userMicrosoftId);
    expect(byId("u1").userMicrosoftId).toBe(ok[0].value.userMicrosoftId);
    expect(mockStore.users).toHaveLength(1);
  });

  test("E11000 retry finding a record bound to a different oid -> denied, never adopted or saved", async () => {
    mockStore.users = [user({ id: "u1", oid: null })];
    mockStore.beforeUpdate = () => {
      byId("u1").userMicrosoftId = OID_3;
      throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    };
    await expect(login(OID_2)).rejects.toBeTruthy();
    expect(byId("u1").userMicrosoftId).toBe(OID_3);
    expect(mockStore.calls.filter((c) => c.startsWith("save:"))).toEqual([]);
  });

  test("E11000 retry finding a PORTAL record -> denied, no conversion", async () => {
    mockStore.users = [user({ id: "u1", oid: OID_1 })];
    mockStore.beforeUpdate = () => {
      byId("u1").userType = "PORTAL";
      throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    };
    await expect(login(OID_1)).rejects.toMatchObject({ status: 403 });
    expect(byId("u1").userType).toBe("PORTAL");
    expect(mockStore.calls.filter((c) => c.startsWith("save:"))).toEqual([]);
  });

  test("E11000 retry finding the same CRM identity -> adopted (unchanged legitimate race)", async () => {
    mockStore.users = [user({ id: "u1", oid: OID_1 })];
    mockStore.beforeUpdate = () => { throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }); };
    const u = await login(OID_1);
    expect(u._id).toBe("u1");
    expect(mockStore.calls).toContain("save:u1");
  });
});

describe("cross-tenant: email matching never links or moves a user in another tenant", () => {
  test("with organisation code: an unbound CRM user with the email in ANOTHER tenant is never read or linked", async () => {
    mockStore.users = [user({ id: "b1", tenant: TENANT_B, oid: null })];
    const before = mockClone(byId("b1"));
    const u = await AzureADHandler.findOrCreateUser(profile(OID_2), { access_token: "at" }, { tenantId: TENANT_A, connectionId: CONN_A });
    expect(String(u.tenantId)).toBe(TENANT_A); // JIT in the login's own tenant (automatic connection)
    expect(snap("b1")).toEqual(before);
  });

  test("without organisation code: a Tenant-B CRM user bound to another oid -> 403, stays in B unchanged", async () => {
    mockStore.users = [user({ id: "b1", tenant: TENANT_B })];
    const before = mockClone(byId("b1"));
    await expect(AzureADHandler.findOrCreateUser(profile(OID_2), { access_token: "at" })).rejects.toMatchObject({ status: 403 });
    expect(snap("b1")).toEqual(before);
    expect(writes()).toEqual([]);
  });

  test("without organisation code: unbound same email in two trusting tenants -> 403 (ambiguous), nothing linked", async () => {
    mockStore.users = [user({ id: "a1", oid: null }), user({ id: "b1", tenant: TENANT_B, oid: null })];
    await expect(AzureADHandler.findOrCreateUser(profile(OID_2), { access_token: "at" })).rejects.toMatchObject({ status: 403 });
    expect(byId("a1").userMicrosoftId).toBeNull();
    expect(byId("b1").userMicrosoftId).toBeNull();
    expect(writes()).toEqual([]);
  });
});
