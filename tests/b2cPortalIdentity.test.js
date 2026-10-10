/**
 * Phase 1C-2Z — portal (B2C) login identity hardening: POST /auth/azure-portal.
 *
 * Runs the REAL controllers/b2c.users.controller.handleMicrosoftCallback and the REAL
 * B2CUsersHandler.handleB2CAuth -> findOrCreateUser. Only the Microsoft round-trip
 * (exchangeCodeForTokens / decodeIdToken - covered by b2cUsersHandler.decodeIdToken.test.js),
 * the models (in-memory, honouring the unique {tenantId,userEmail} index), role sync, publishers
 * and the JWT signer are stubbed. PKCE state/nonce/policy binding is the real pkceStateStore.
 *
 * Before: an inactive user got a JWT; a CRM user with the same email was matched, converted to
 * PORTAL (keeping CRM roles) and got a portal JWT; a same-email user in ANOTHER real tenant was
 * moved into the B2C tenant. After: inactive / non-PORTAL users get a fixed 403 with no update, no
 * lastLogin change, no role sync, no event and no JWT; other-tenant users are never moved (a new
 * PORTAL user is created in the B2C tenant). Legacy PORTAL users whose tenantId is not a real
 * Tenant are still migrated (unchanged).
 */
const B2C_TENANT = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbbbbbbbbbbbbbbbbbb";
const DENIED = "Portal sign-in is not available for this account";

const mockStore = { users: [], calls: [], failNextUpdate: null, realTenants: [] };
const mockMatches = (u, q) =>
  Object.entries(q).every(([k, v]) =>
    v && typeof v === "object" && "$ne" in v ? u[k] !== v.$ne : String(u[k]) === String(v),
  );
const mockClone = (o) => JSON.parse(JSON.stringify(o));
const mockDoc = (u) =>
  Object.assign(u, {
    save: async function save() { mockStore.calls.push(`save:${u._id}`); return this; },
  });

jest.mock("../models/user.model", () => ({
  findOne: (q) => {
    const r = mockStore.users.find((u) => mockMatches(u, q));
    const p = Promise.resolve(r ? mockDoc(r) : null);
    p.lean = async () => (r ? mockClone(r) : null);
    return p;
  },
  find: (q) => ({ lean: async () => mockStore.users.filter((u) => mockMatches(u, q)).map(mockClone) }),
  findOneAndUpdate: async (q, upd, opts) => {
    mockStore.calls.push(`update:${JSON.stringify(q)}:upsert=${opts.upsert}`);
    if (mockStore.failNextUpdate) {
      const f = mockStore.failNextUpdate;
      mockStore.failNextUpdate = null;
      f();
    }
    let r = mockStore.users.find((u) => mockMatches(u, q));
    const set = upd.$set || {};
    if (!r && !opts.upsert) return null;
    if (!r) {
      if (mockStore.users.some((u) => u.userEmail === set.userEmail && String(u.tenantId) === String(set.tenantId))) {
        const e = new Error("E11000 duplicate key error");
        e.code = 11000;
        throw e;
      }
      r = { _id: `new-${set.userEmail}`, isActive: true, roles: [], ...(upd.$setOnInsert || {}) };
      mockStore.users.push(r);
      mockStore.calls.push("insert");
    }
    Object.assign(r, mockClone(set));
    return mockDoc(r);
  },
}));
jest.mock("../models/tenant.model", () => ({
  exists: async (q) => (mockStore.realTenants.includes(String(q._id)) ? { _id: q._id } : null),
}));
jest.mock("../helpers/portalRoleSync", () => ({
  syncPortalUserRolesFromMembership: async (u, email, t, o) => {
    mockStore.calls.push(`roleSync:${email}:new=${o.isNewUser}`);
    return {};
  },
}));
jest.mock("../rabbitMQ/publishers/user.portal.publisher", () => ({
  publishPortalUserCreated: async () => mockStore.calls.push("publishCreated"),
  publishPortalUserUpdated: async () => mockStore.calls.push("publishUpdated"),
}));
jest.mock("../helpers/oauthTokenStorage", () => ({ buildUserTokensSubdocument: () => ({ stored: true }) }));
jest.mock("../helpers/jwt", () => ({
  generateToken: async (u) => {
    mockStore.calls.push(`jwt:${u.userEmail}:${u.userType}:${u.tenantId}`);
    return { token: "signed.jwt.token" };
  },
}));

const B2CUsersHandler = require("../handlers/b2c.users.handler");
const { handleMicrosoftCallback } = require("../controllers/b2c.users.controller");
const { rememberStatePolicy, rememberNonceForState } = require("../helpers/pkceStateStore");

const OLD_LOGIN = "2020-01-01T00:00:00.000Z";
const user = (o) => ({
  _id: o.id,
  userEmail: o.email,
  tenantId: o.tenant,
  userType: o.type,
  isActive: o.active !== false,
  userMicrosoftId: o.oid,
  userLastLogin: OLD_LOGIN,
  roles: o.roles || [],
});

let profile;
let seq = 0;
const login = async (email, oid) => {
  profile = { email, oid };
  const state = `state-${++seq}`;
  rememberStatePolicy(state, "B2C_1_projectshell_signin");
  rememberNonceForState(state, `nonce-${seq}`);
  const out = { status: null, body: null, err: null };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
  await handleMicrosoftCallback({ body: { code: "c", codeVerifier: "v", state }, headers: {} }, res, (e) => { out.err = e; });
  return out;
};
const byId = (id) => mockStore.users.find((u) => u._id === id);
const expectDenied = (out) => {
  expect(out.status).toBeNull();
  expect(out.err).toMatchObject({ name: "AppError", status: 403, code: "FORBIDDEN", message: DENIED });
  expect(Object.keys(out.err).sort()).toEqual(["code", "name", "status"]);
};
const noSideEffects = () => {
  expect(mockStore.calls.filter((c) => /^(update|save|insert|roleSync|publish|jwt)/.test(c))).toEqual([]);
};

let warnLogs;
beforeEach(() => {
  mockStore.users = [];
  mockStore.calls = [];
  mockStore.failNextUpdate = null;
  mockStore.realTenants = [B2C_TENANT, OTHER_TENANT];
  warnLogs = [];
  process.env.MS_B2C_DIRECTORY_ID = "b2c-dir";
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation((...a) => warnLogs.push(a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")));
  jest.spyOn(B2CUsersHandler, "exchangeCodeForTokens").mockResolvedValue({ id_token: "idt", refresh_token: "rt" });
  jest.spyOn(B2CUsersHandler, "decodeIdToken").mockImplementation(async () => ({
    userEmail: profile.email,
    userMicrosoftId: profile.oid,
    userFirstName: "F",
    userLastName: "L",
    tenantId: B2C_TENANT,
    microsoftDirectoryId: "b2c-dir",
  }));
});
afterEach(() => jest.restoreAllMocks());

describe("allowed logins (unchanged)", () => {
  test("A active PORTAL user, same email + tenant -> 200 JWT; updated by _id; lastLogin, role sync, event", async () => {
    mockStore.users = [user({ id: "p1", email: "m@x.com", tenant: B2C_TENANT, type: "PORTAL", oid: "oid-1" })];
    const out = await login("m@x.com", "oid-1");
    expect(out.err).toBeNull();
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ success: true, accessToken: "signed.jwt.token", refreshToken: "rt", user: { id: "p1", userType: "PORTAL" } });
    expect(mockStore.calls).toEqual([
      'update:{"_id":"p1","userType":{"$ne":"CRM"},"isActive":{"$ne":false}}:upsert=false',
      "roleSync:m@x.com:new=false",
      "publishUpdated",
      `jwt:m@x.com:PORTAL:${B2C_TENANT}`,
    ]);
    expect(byId("p1").userLastLogin).not.toBe(OLD_LOGIN);
  });

  test("D new user -> 200; inserted as PORTAL in the B2C tenant; role sync new=true; created event", async () => {
    const out = await login("new@x.com", "oid-new");
    expect(out.status).toBe(200);
    expect(mockStore.calls).toEqual([
      `update:{"userEmail":"new@x.com","tenantId":"${B2C_TENANT}"}:upsert=true`,
      "insert",
      "roleSync:new@x.com:new=true",
      "publishCreated",
      `jwt:new@x.com:PORTAL:${B2C_TENANT}`,
    ]);
    expect(mockStore.users).toHaveLength(1);
    expect(mockStore.users[0]).toMatchObject({ userType: "PORTAL", tenantId: B2C_TENANT, userMicrosoftId: "oid-new" });
  });

  test("legacy PORTAL user whose tenantId is not a real Tenant is still migrated into the B2C tenant", async () => {
    mockStore.users = [user({ id: "p4", email: "old@x.com", tenant: "legacy-directory-id", type: "PORTAL", oid: "oid-old" })];
    const out = await login("old@x.com", "oid-old");
    expect(out.status).toBe(200);
    expect(byId("p4")).toMatchObject({ tenantId: B2C_TENANT, userType: "PORTAL" });
    expect(mockStore.users).toHaveLength(1);
    expect(mockStore.calls).toContain("roleSync:old@x.com:new=false");
  });

  test("legacy PORTAL user with a 24-hex tenantId that is not an existing Tenant is migrated", async () => {
    mockStore.users = [user({ id: "p6", email: "hex@x.com", tenant: "cccccccccccccccccccccccc", type: "PORTAL" })];
    const out = await login("hex@x.com", "oid-6");
    expect(out.status).toBe(200);
    expect(byId("p6").tenantId).toBe(B2C_TENANT);
  });
});

describe("inactive users are denied before JWT issuance", () => {
  test("inactive PORTAL user -> 403 fixed message; no update/lastLogin/role sync/event/JWT", async () => {
    mockStore.users = [user({ id: "p2", email: "m@x.com", tenant: B2C_TENANT, type: "PORTAL", oid: "oid-1", active: false, roles: ["MEMBER"] })];
    const out = await login("m@x.com", "oid-1");
    expectDenied(out);
    noSideEffects();
    expect(byId("p2")).toMatchObject({ isActive: false, userLastLogin: OLD_LOGIN, roles: ["MEMBER"], userMicrosoftId: "oid-1" });
    expect(warnLogs.some((l) => l.includes("INACTIVE_USER") && l.includes("p2"))).toBe(true);
  });

  test("inactive legacy PORTAL user -> 403 and is NOT migrated", async () => {
    mockStore.users = [user({ id: "p7", email: "old@x.com", tenant: "legacy-directory-id", type: "PORTAL", active: false })];
    expectDenied(await login("old@x.com", "oid-7"));
    noSideEffects();
    expect(byId("p7").tenantId).toBe("legacy-directory-id");
  });

  test("user deactivated between lookup and update -> 403, nothing inserted", async () => {
    mockStore.users = [user({ id: "p8", email: "m@x.com", tenant: B2C_TENANT, type: "PORTAL" })];
    mockStore.failNextUpdate = () => { byId("p8").isActive = false; };
    const out = await login("m@x.com", "oid-8");
    expectDenied(out);
    expect(mockStore.users).toHaveLength(1);
    expect(mockStore.calls.filter((c) => /^(insert|roleSync|publish|jwt)/.test(c))).toEqual([]);
  });
});

describe("CRM users are never matched or converted by portal login", () => {
  test("B CRM user, same email + tenant -> 403; stays CRM with its oid, roles, lastLogin", async () => {
    mockStore.users = [user({ id: "c1", email: "admin@x.com", tenant: B2C_TENANT, type: "CRM", oid: "entra-oid", roles: ["SU-role"] })];
    const out = await login("admin@x.com", "b2c-oid-9");
    expectDenied(out);
    noSideEffects();
    expect(byId("c1")).toMatchObject({ userType: "CRM", userMicrosoftId: "entra-oid", roles: ["SU-role"], userLastLogin: OLD_LOGIN });
    expect(warnLogs.some((l) => l.includes("NON_PORTAL_USER"))).toBe(true);
  });

  test("C CRM user with the same email in ANOTHER tenant is untouched; a separate PORTAL user is created", async () => {
    mockStore.users = [user({ id: "c2", email: "staff@x.com", tenant: OTHER_TENANT, type: "CRM", oid: "entra-2", roles: ["GS"] })];
    const out = await login("staff@x.com", "b2c-oid-8");
    expect(out.status).toBe(200);
    expect(byId("c2")).toMatchObject({ tenantId: OTHER_TENANT, userType: "CRM", userMicrosoftId: "entra-2", roles: ["GS"], userLastLogin: OLD_LOGIN });
    const created = mockStore.users.find((u) => u._id !== "c2");
    expect(created).toMatchObject({ tenantId: B2C_TENANT, userType: "PORTAL", userMicrosoftId: "b2c-oid-8", roles: [] });
    expect(mockStore.calls).toContain("roleSync:staff@x.com:new=true");
  });

  test("CRM user with a legacy (non-Tenant) tenantId is not migrated or converted", async () => {
    mockStore.users = [user({ id: "c3", email: "crm-old@x.com", tenant: "legacy-directory-id", type: "CRM" })];
    const out = await login("crm-old@x.com", "oid-c3");
    expect(out.status).toBe(200);
    expect(byId("c3")).toMatchObject({ tenantId: "legacy-directory-id", userType: "CRM" });
    expect(mockStore.users).toHaveLength(2);
  });

  test("user converted to CRM between lookup and update -> 403", async () => {
    mockStore.users = [user({ id: "p9", email: "m@x.com", tenant: B2C_TENANT, type: "PORTAL" })];
    mockStore.failNextUpdate = () => { byId("p9").userType = "CRM"; };
    expectDenied(await login("m@x.com", "oid-9"));
    expect(byId("p9").userType).toBe("CRM");
  });
});

describe("users are never moved across real tenants", () => {
  test("C2 PORTAL user in another real tenant stays there; a new PORTAL user is created in the B2C tenant", async () => {
    mockStore.users = [user({ id: "p3", email: "m2@x.com", tenant: OTHER_TENANT, type: "PORTAL", oid: "oid-x", roles: ["MEMBER"] })];
    const out = await login("m2@x.com", "oid-x");
    expect(out.status).toBe(200);
    expect(byId("p3")).toMatchObject({ tenantId: OTHER_TENANT, roles: ["MEMBER"], userLastLogin: OLD_LOGIN });
    expect(mockStore.users.find((u) => u._id !== "p3")).toMatchObject({ tenantId: B2C_TENANT, userType: "PORTAL" });
  });

  test("two legacy candidates for one email are ambiguous: neither is moved; a new user is created", async () => {
    mockStore.users = [
      user({ id: "l1", email: "dup@x.com", tenant: "legacy-a", type: "PORTAL" }),
      user({ id: "l2", email: "dup@x.com", tenant: "legacy-b", type: "PORTAL" }),
    ];
    const out = await login("dup@x.com", "oid-dup");
    expect(out.status).toBe(200);
    expect([byId("l1").tenantId, byId("l2").tenantId]).toEqual(["legacy-a", "legacy-b"]);
    expect(mockStore.users).toHaveLength(3);
  });

  test("the JWT is always issued for the B2C tenant resolved from MS_B2C_DIRECTORY_ID", async () => {
    mockStore.users = [user({ id: "p3", email: "m2@x.com", tenant: OTHER_TENANT, type: "PORTAL" })];
    await login("m2@x.com", "oid-x");
    expect(mockStore.calls.filter((c) => c.startsWith("jwt:"))).toEqual([`jwt:m2@x.com:PORTAL:${B2C_TENANT}`]);
  });
});

describe("E11000 recovery path applies the same guards", () => {
  // Another request inserts the same {tenantId,userEmail} first; this upsert then fails with E11000.
  const raceInsert = (u) => () => {
    mockStore.users.push(u);
    const e = new Error("E11000 duplicate key error");
    e.code = 11000;
    throw e;
  };

  test("concurrently-created active PORTAL user -> recovered, 200", async () => {
    mockStore.failNextUpdate = raceInsert(user({ id: "r1", email: "race@x.com", tenant: B2C_TENANT, type: "PORTAL" }));
    const out = await login("race@x.com", "oid-r1");
    expect(out.status).toBe(200);
    expect(mockStore.calls).toEqual(expect.arrayContaining(["save:r1", "roleSync:race@x.com:new=false"]));
  });

  test.each([
    ["CRM", { type: "CRM" }],
    ["inactive", { type: "PORTAL", active: false }],
  ])("concurrently-created %s user -> 403; not saved, no role sync, no JWT", async (_l, o) => {
    mockStore.failNextUpdate = raceInsert(user({ id: "r2", email: "race@x.com", tenant: B2C_TENANT, ...o }));
    const out = await login("race@x.com", "oid-r2");
    expectDenied(out);
    expect(mockStore.calls.filter((c) => /^(save|roleSync|publish|jwt)/.test(c))).toEqual([]);
    expect(byId("r2").userLastLogin).toBe(OLD_LOGIN);
  });
});

describe("controller error mapping", () => {
  test("non-AppError failures keep the generic 500 'Microsoft authentication failed'", async () => {
    B2CUsersHandler.exchangeCodeForTokens.mockRejectedValueOnce(new Error("INTERNAL_MARKER redis://secret-host"));
    const out = await login("m@x.com", "oid-1");
    expect(out.err).toMatchObject({ status: 500, message: "Microsoft authentication failed" });
  });

  test("ID-token verification failures keep 401", async () => {
    B2CUsersHandler.decodeIdToken.mockRejectedValueOnce(new Error("B2C token nonce mismatch"));
    const out = await login("m@x.com", "oid-1");
    expect(out.err).toMatchObject({ status: 401, message: "Microsoft authentication failed" });
  });
});
