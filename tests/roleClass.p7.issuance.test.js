/**
 * P7 role / user-type compatibility at token issuance (helpers/jwt.js generateToken), real
 * handlers/role.handler.js permission resolution over mocked models.
 *
 *  - off and shadow: the signed payload is identical to today's for every user (shadow only logs what
 *    enforce would drop, and the shadow log's own failure never affects issuance).
 *  - enforce: incompatible roles are dropped from `roles` and permissions are REBUILT from the
 *    compatible roles only: "*" only when a compatible ASU remains; a permission an incompatible role
 *    also grants is kept when a compatible role grants it.
 *  - stored assignments are never changed by issuance (incompatible roles are only left out).
 *  - missing / unknown STORED user type (including a Mongoose-defaulted PORTAL): enforce refuses
 *    issuance with a 403 AppError USER_TYPE_INVALID (no token, not even the role-less fallback);
 *    shadow issues today's token and logs. Controller-level sign-in / refresh: roleClass.p7.signin.test.js.
 */
const jwt = require("jsonwebtoken");

const A = "68cbf7806080b4621d469d34";
const role = (id, code, category, permissions) => ({ _id: `a0000000000000000000000${id}`, tenantId: A, code, name: code, category, isActive: true, permissions });
const R = {
  mo: role(1, "MO", "PORTAL", ["PROFILE_READ", "PROFILE_WRITE"]),
  reo: role(2, "REO", "CRM", ["PROFILE_READ"]),
  member: role(3, "MEMBER", "PORTAL", ["PROFILE_READ", "PORTAL_READ"]),
  nonMember: role(4, "NON-MEMBER", "PORTAL", ["PORTAL_READ"]),
  asu: role(5, "ASU", "SYSTEM", []),
  custom: role(6, "CUSTOM1", undefined, ["legacy:thing", "PROFILE_READ"]),
};
const CATALOGUE = [
  { _id: "70000000000000000000000a", code: "PROFILE_READ", resource: "profile", action: "read", isActive: true },
  { _id: "70000000000000000000000b", code: "PROFILE_WRITE", resource: "profile", action: "write", isActive: true },
  { _id: "70000000000000000000000c", code: "PORTAL_READ", resource: "portal", action: "read", isActive: true },
];
const mockStore = { users: {} };

jest.mock("../models/user.model", () => ({
  findOne: (q) => {
    const u = mockStore.users[String(q._id)];
    const hit = u && u.tenantId === q.tenantId ? u : null;
    const p = Promise.resolve(hit);
    p.populate = () => Promise.resolve(hit);
    return p;
  },
}));
jest.mock("../models/permission.model", () => ({
  find: (q) => {
    const [field, cond] = Object.entries(q)[0];
    const rows = mockCatalogue.filter((p) => cond.$in.map(String).includes(String(p[field === "_id" ? "_id" : "code"])));
    return Promise.resolve(rows);
  },
}));
jest.mock("../models/role.model", () => ({}));
jest.mock("../models/tenant.model", () => ({}));
const mockCatalogue = CATALOGUE;

const RoleHandler = require("../handlers/role.handler");
const { generateToken } = require("../helpers/jwt");
const { AppError } = require("../errors/AppError");

const USERS = {
  crmMoMember: { userType: "CRM", roles: [R.mo, R.member] },
  crmAsuMember: { userType: "CRM", roles: [R.asu, R.member] },
  crmAsu: { userType: "CRM", roles: [R.asu] },
  crmReoCustom: { userType: "CRM", roles: [R.reo, R.custom] },
  crmMo: { userType: "CRM", roles: [R.mo, R.reo] },
  portalMemberAsu: { userType: "PORTAL", roles: [R.member, R.asu] },
  portalMemberMo: { userType: "PORTAL", roles: [R.member, R.mo] },
  portalMember: { userType: "PORTAL", roles: [R.member] },
  portalNonMember: { userType: "PORTAL", roles: [R.nonMember] },
  noRoles: { userType: "CRM", roles: [] },
};
let n = 0;
function seed(key, overrides = {}) {
  const id = `c${String(++n).padStart(23, "0")}`;
  const spec = { ...USERS[key], ...overrides };
  const u = { _id: id, tenantId: A, userEmail: "u@example.test", roles: spec.roles };
  if ("userType" in spec && spec.userType !== undefined) u.userType = spec.userType;
  mockStore.users[id] = u;
  return { _id: id, tenantId: A, userEmail: "u@example.test", ...(u.userType !== undefined ? { userType: u.userType } : {}) };
}
const payload = (tokenData) => {
  const { iat, exp, ...rest } = jwt.decode(tokenData.token);
  return rest;
};
const codes = (p) => p.roles.map((r) => r.code);
const savedMode = process.env.ROLE_CLASS_MODE;
let warn;
const setMode = (m) => { if (m === undefined) delete process.env.ROLE_CLASS_MODE; else process.env.ROLE_CLASS_MODE = m; };
const classLogs = () => warn.mock.calls.filter((c) => c[0] === "[ROLE_CLASS]").map((c) => JSON.parse(c[1]));

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "p7-test-only-secret";
  process.env.JWT_EXPIRY = process.env.JWT_EXPIRY || "1h";
});
beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  setMode(savedMode);
});

async function issue(mode, user) {
  setMode(mode);
  return payload(await generateToken(user));
}

describe("off and shadow keep today's token exactly", () => {
  test.each(Object.keys(USERS))("%s: unset == off == shadow", async (key) => {
    const user = seed(key);
    const today = await issue(undefined, user);
    expect(await issue("off", user)).toEqual(today);
    expect(await issue("shadow", user)).toEqual(today);
  });

  test("today's behaviour that enforce changes is visible in the baseline (PORTAL + ASU gets *)", async () => {
    const p = await issue("off", seed("portalMemberAsu"));
    expect(p.permissions).toEqual(["*"]);
    expect(codes(p)).toEqual(["MEMBER", "ASU"]);
  });

  test("off logs nothing", async () => {
    for (const key of Object.keys(USERS)) await issue("off", seed(key));
    expect(classLogs()).toHaveLength(0);
  });

  test("shadow logs what enforce would drop: counts, codes, wildcard loss; no permission lists", async () => {
    await issue("shadow", seed("portalMemberAsu"));
    await issue("shadow", seed("crmMoMember"));
    await issue("shadow", seed("crmMo")); // all compatible: no line
    const logs = classLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      event: "role.class.shadow",
      path: "token-issuance",
      outcome: "roles_would_be_dropped",
      userType: "PORTAL",
      dropped: [{ roleCode: "ASU", reason: "ROLE_CLASS_MISMATCH" }],
      rolesBefore: 2,
      rolesAfter: 1,
      permissionsBefore: 1,
      permissionsAfter: 2,
      permissionsLost: 1,
      wildcardLost: true,
    });
    expect(logs[1]).toMatchObject({
      dropped: [{ roleCode: "MEMBER", reason: "ROLE_CLASS_MISMATCH" }],
      permissionsBefore: 3,
      permissionsAfter: 2,
      permissionsLost: 1,
      wildcardLost: false,
    });
    for (const l of logs) {
      expect(l).not.toHaveProperty("permissions");
      expect(l).not.toHaveProperty("email");
      expect(l.tenantId).toBe("68cb..9d34");
    }
  });

  test("a failure inside the shadow evaluation never changes the token", async () => {
    const user = seed("crmMoMember");
    const today = await issue("off", user);
    jest.spyOn(RoleHandler, "permissionsForRoles").mockRejectedValueOnce(new Error("boom"));
    expect(await issue("shadow", user)).toEqual(today);
  });
});

describe("enforce rebuilds roles and permissions from compatible roles only", () => {
  test("PORTAL + MEMBER + ASU: ASU dropped, no *, MEMBER permissions issued", async () => {
    const p = await issue("enforce", seed("portalMemberAsu"));
    expect(codes(p)).toEqual(["MEMBER"]);
    expect(p.permissions.sort()).toEqual(["portal:read", "profile:read"]);
    expect(p.permissions).not.toContain("*");
  });

  test("CRM + ASU + MEMBER: MEMBER dropped, * kept from the compatible ASU", async () => {
    const p = await issue("enforce", seed("crmAsuMember"));
    expect(codes(p)).toEqual(["ASU"]);
    expect(p.permissions).toEqual(["*"]);
  });

  test("CRM + MO + MEMBER: profile:read kept (also granted by MO), portal:read removed", async () => {
    const p = await issue("enforce", seed("crmMoMember"));
    expect(codes(p)).toEqual(["MO"]);
    expect(p.permissions.sort()).toEqual(["profile:read", "profile:write"]);
  });

  test("PORTAL + MEMBER + MO: profile:read kept (also granted by MEMBER), profile:write removed", async () => {
    const p = await issue("enforce", seed("portalMemberMo"));
    expect(codes(p)).toEqual(["MEMBER"]);
    expect(p.permissions.sort()).toEqual(["portal:read", "profile:read"]);
  });

  test("CRM + REO + custom role without category: custom dropped with its literal permission", async () => {
    const p = await issue("enforce", seed("crmReoCustom"));
    expect(codes(p)).toEqual(["REO"]);
    expect(p.permissions).toEqual(["profile:read"]);
    expect(classLogs()[0]).toMatchObject({ event: "role.class.enforce", outcome: "roles_dropped", dropped: [{ roleCode: "CUSTOM1", reason: "CATEGORY_MISSING" }] });
  });

  test.each(["crmAsu", "crmMo", "portalMember", "portalNonMember", "noRoles"])(
    "%s (all compatible): enforce token == today's token",
    async (key) => {
      const user = seed(key);
      expect(await issue("enforce", user)).toEqual(await issue("off", user));
    }
  );

  test("issuance leaves the stored assignment untouched (incompatible roles stay in storage)", async () => {
    const user = seed("portalMemberAsu");
    const before = mockStore.users[user._id].roles.map((r) => r.code);
    await issue("enforce", user);
    expect(mockStore.users[user._id].roles.map((r) => r.code)).toEqual(before);
    expect(before).toEqual(["MEMBER", "ASU"]);
  });

  test("roles claim keeps today's {id, code, name} shape", async () => {
    const p = await issue("enforce", seed("crmMoMember"));
    expect(p.roles).toEqual([{ id: R.mo._id, code: "MO", name: "MO" }]);
  });
});

describe("missing and unknown user types", () => {
  const sign = () => jest.spyOn(jwt, "sign");

  test.each([["missing", undefined], ["unknown", "ADMIN"], ["blank", ""]])(
    "%s user type: enforce refuses issuance with 403 USER_TYPE_INVALID (no token, no role-less fallback)",
    async (_l, userType) => {
      const user = seed("crmMo", { userType });
      if (userType === "") user.userType = "";
      setMode("enforce");
      const s = sign();
      const err = await generateToken(user).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ name: "AppError", status: 403, code: "USER_TYPE_INVALID" });
      expect(err.message).toBe("Sign-in is not available for this account");
      expect(s).not.toHaveBeenCalled();
      expect(classLogs()[0]).toMatchObject({ event: "role.class.enforce", outcome: "issuance_refused", reason: userType ? "USER_TYPE_UNKNOWN" : "USER_TYPE_MISSING" });
    }
  );

  test("a Mongoose-defaulted userType (stored value absent) counts as missing, not PORTAL", async () => {
    const user = seed("portalMember");
    user.$isDefault = (path) => path === "userType"; // what a hydrated document without userType reports
    setMode("enforce");
    const s = sign();
    await expect(generateToken(user)).rejects.toMatchObject({ status: 403, code: "USER_TYPE_INVALID" });
    expect(s).not.toHaveBeenCalled();
    expect(classLogs()[0]).toMatchObject({ reason: "USER_TYPE_MISSING", userType: null });
    // off: today's token (PORTAL as the schema default says)
    expect(codes(await issue("off", user))).toEqual(["MEMBER"]);
  });

  test.each([["missing", undefined], ["unknown", "ADMIN"]])(
    "%s user type: shadow issues today's token and logs issuance_would_be_refused",
    async (_l, userType) => {
      const user = seed("crmMo", { userType });
      const today = await issue("off", user);
      expect(await issue("shadow", user)).toEqual(today);
      const logs = classLogs();
      expect(logs).toHaveLength(1); // one line, not one more per held role
      expect(logs[0]).toMatchObject({ event: "role.class.shadow", outcome: "issuance_would_be_refused", reason: userType ? "USER_TYPE_UNKNOWN" : "USER_TYPE_MISSING" });
    }
  );

  test("off: missing user type issues today's token without any class evaluation", async () => {
    const user = seed("crmMo", { userType: undefined });
    const p = await issue("off", user);
    expect(codes(p)).toEqual(["MO", "REO"]);
    expect(classLogs()).toHaveLength(0);
  });
});

describe("existing failure behaviour is unchanged in enforce", () => {
  test("a role lookup failure still yields today's role-less fallback token", async () => {
    const user = seed("crmMo");
    jest.spyOn(RoleHandler, "getUserRoles").mockRejectedValueOnce(new Error("db down"));
    const p = await issue("enforce", user);
    expect(p.roles).toEqual([]);
    expect(p.permissions).toEqual([]);
  });
});
