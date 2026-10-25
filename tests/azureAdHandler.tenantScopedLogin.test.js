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
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(u[k] ?? null));
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
jest.mock("../helpers/oauthTokenStorage", () => ({ buildUserTokensSubdocument: () => ({ stored: true }) }));
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

describe("positive cases: same Entra directory, tenant chosen by the login context", () => {
  test("S1 User A through MULTIAUTH -> existing MULTIAUTH user, updated by _id", async () => {
    mockStore.users = [crmUser({ id: "a1", email: EMAIL_A, tenant: TENANT_A, oid: OID_A })];
    const u = await login(EMAIL_A, OID_A, ctxA);
    expect(u._id).toBe("a1");
    expect(String(u.tenantId)).toBe(TENANT_A);
    expect(mockStore.calls).toContain(`update:{"_id":"a1","isActive":{"$ne":false},"userType":"CRM","userMicrosoftId":"${OID_A}"}`);
  });

  test("S2 User B through DEVTENANTB, first login -> JIT user created ONLY in DEVTENANTB, keyed by oid", async () => {
    mockStore.users = [crmUser({ id: "a1", email: EMAIL_A, tenant: TENANT_A, oid: OID_A })];
    const u = await login(EMAIL_B, OID_B, ctxB);
    expect(String(u.tenantId)).toBe(TENANT_B);
    expect(u.userMicrosoftId).toBe(OID_B);
    expect(u.userEmail).toBe(EMAIL_B);
    expect(usersIn(TENANT_B)).toHaveLength(1);
    expect(usersIn(TENANT_A)).toHaveLength(1);
    expect(mockStore.calls).toEqual(expect.arrayContaining([`insert:${TENANT_B}`, `defaultRole:${TENANT_B}`, "publishCreated"]));
    expect(mockStore.calls).toContain(`update:${JSON.stringify({ tenantId: TENANT_B, userMicrosoftId: OID_B })}`);
    expect(u.roles).toEqual(["role-default"]); // assigned in the same insert, never role-less
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
    expect(mockStore.calls).not.toEqual(expect.arrayContaining([expect.stringContaining(`"_id":"a1"`)]));
  });

  test("I2 DEVTENANTB with autoProvisionUsers:false -> 403, nothing written anywhere", async () => {
    mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { autoProvisionUsers: false })];
    mockStore.users = [crmUser({ id: "a1", email: EMAIL_B, tenant: TENANT_A, oid: OID_B })];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ name: "AppError", status: 403 });
    expect(mockStore.calls).toEqual([]);
    expect(byId("a1").tenantId).toBe(TENANT_A); // the wrongly-placed A record is not silently moved
  });

  test("I2b DEVTENANTB with autoProvisionUsers UNSET -> 403 (unset = pre-authorised only), nothing written", async () => {
    mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { autoProvisionUsers: undefined })];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ name: "AppError", status: 403 });
    expect(mockStore.calls).toEqual([]);
    expect(usersIn(TENANT_B)).toHaveLength(0);
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

  test("F4 no organisation code: a new identity is refused even when exactly ONE tenant auto-provisions", async () => {
    mockStore.tenants[0].authenticationConnections = [conn(CONN_A, { autoProvisionUsers: false })];
    await expect(login(EMAIL_B, OID_B, null)).rejects.toMatchObject({ status: 403 });
    expect(mockStore.calls).toEqual([]);
    expect(mockStore.users).toHaveLength(0);
  });

  test("F5 no organisation code: an existing user without an active role is refused too", async () => {
    mockStore.users = [{ ...crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B }), roles: [] }];
    await expect(login(EMAIL_B, OID_B, null)).rejects.toMatchObject({ status: 403, message: "You don't have access to this organisation" });
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

describe("Phase 2a: access checks and default role at CRM sign-in", () => {
  test("P1 existing user with isActive=false -> 403 before any update, role processing or token", async () => {
    mockStore.users = [{ ...crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B }), isActive: false }];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403, message: "CRM sign-in is not available for this account" });
    expect(mockStore.calls).toEqual([]);
    expect(byId("b1").userLastLogin).toBeUndefined();
  });

  test("P2 existing user with zero active roles -> 403 'no access', REO is NOT restored", async () => {
    mockStore.users = [{ ...crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B }), roles: [] }];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403, message: "You don't have access to this organisation" });
    expect(mockStore.calls).toEqual([]);
    expect(byId("b1").roles).toEqual([]);
  });

  test("P3 existing user is reused when the connection is NOT automatic (false or unset)", async () => {
    for (const flag of [false, undefined]) {
      mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { autoProvisionUsers: flag })];
      mockStore.users = [crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B })];
      mockStore.calls = [];
      const u = await login(EMAIL_B, OID_B, ctxB);
      expect(u._id).toBe("b1");
      expect(mockStore.calls).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(insert|defaultRole)/)]));
    }
  });

  test("P4 configured default role unusable at login -> JIT refused, no user created", async () => {
    mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { defaultRoleId: "broken" })];
    await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403 });
    expect(usersIn(TENANT_B)).toHaveLength(0);
    expect(mockStore.calls).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(insert|update|publish)/)]));
  });

  test("P5 user deactivated between lookup and update -> 403, never upserted", async () => {
    mockStore.users = [crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B })];
    const User = require("../models/user.model");
    const orig = User.findOneAndUpdate;
    User.findOneAndUpdate = async (q, upd, opts) => {
      byId("b1").isActive = false;
      return orig(q, upd, opts);
    };
    try {
      await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403 });
    } finally {
      User.findOneAndUpdate = orig;
    }
    expect(mockStore.users).toHaveLength(1);
  });
});

describe("Phase 2b: automatic provisioning requires an explicit default role", () => {
  test("Q1 Automatic connection without a default role: a new identity -> 403, no user, no event", async () => {
    for (const missing of [{ defaultRoleId: undefined }, { defaultRoleId: null }]) {
      mockStore.tenants[1].authenticationConnections = [conn(CONN_B, missing)];
      mockStore.users = [];
      mockStore.calls = [];
      await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403, message: "CRM sign-in is not available for this account" });
      expect(mockStore.users).toHaveLength(0);
      expect(mockStore.calls).toEqual([`defaultRole:${TENANT_B}`]); // refused there: no insert, update or publish
    }
  });

  test("Q2 an existing user signs in through an Automatic connection without a default role", async () => {
    mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { defaultRoleId: undefined })];
    mockStore.users = [crmUser({ id: "b1", email: EMAIL_B, tenant: TENANT_B, oid: OID_B })];
    const u = await login(EMAIL_B, OID_B, ctxB);
    expect(u._id).toBe("b1");
    expect(byId("b1").roles).toEqual(["r"]);
    expect(mockStore.calls).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(insert|defaultRole)/)]));
  });

  test("Q3 pre-authorised (false or unset) connection: an unknown identity is refused without any JIT step", async () => {
    for (const flag of [false, undefined]) {
      mockStore.tenants[1].authenticationConnections = [conn(CONN_B, { autoProvisionUsers: flag, defaultRoleId: undefined })];
      mockStore.users = [];
      mockStore.calls = [];
      await expect(login(EMAIL_B, OID_B, ctxB)).rejects.toMatchObject({ status: 403 });
      expect(mockStore.users).toHaveLength(0);
      expect(mockStore.calls).toEqual([]);
    }
  });
});
