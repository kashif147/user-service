/**
 * P7 role / user-type compatibility for connection default roles (helpers/connectionDefaultRole.js):
 * save-time checks, the CRM role picker and Entra / B2C just-in-time sign-in all use
 * defaultRoleIneligibility.
 *
 * Today's rule always decides first (Entra: category CRM; B2C: category PORTAL + NON-MEMBER; then
 * protected-role, verifiable and reserved-permission checks). The class check is ONLY an additional
 * restriction (owner decision 2026-11-10: today's automatic default-role eligibility is preserved;
 * any expansion is a separate decision):
 *  - off: today's rule only.
 *  - shadow: today's result; a role the class check would additionally refuse is logged.
 *  - enforce: today's rule AND class (Entra default must be class CRM, B2C class PORTAL).
 * So enforce can only remove eligibility, never add it.
 */
const ORG_A = "68cbf7806080b4621d469d34";
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const id = (n) => `5${String(n).padStart(23, "0")}`;
const mockRoles = [];
const mockRole = (n, o) => ({
  _id: id(n), tenantId: ORG_A, name: `Role ${n}`, code: `R${n}`, category: "CRM", isActive: true,
  isSystemRole: false, level: 1, permissions: ["profile:read"], ...o,
});
const mockMatch = (r, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(r[k]));
    return String(r[k]) === String(v);
  });
const mockChain = (rows) => {
  const c = { select: () => c, sort: () => c, lean: async () => rows.map((r) => ({ ...r })) };
  return c;
};
jest.mock("../models/role.model", () => ({
  findOne: (q) => {
    const r = mockRoles.find((x) => mockMatch(x, q));
    return { select() { return this; }, lean: async () => (r ? { ...r } : null) };
  },
  find: (q) => mockChain(mockRoles.filter((x) => mockMatch(x, q))),
  countDocuments: async (q) => mockRoles.filter((x) => mockMatch(x, q)).length,
}));
jest.mock("../models/permission.model", () => ({
  find: () => ({ select: () => ({ lean: async () => [] }) }),
}));

const H = require("../helpers/connectionDefaultRole");

// Live-like data: MULTIAUTH stores most staff roles as category PORTAL; REO as CRM.
const ROLES = {
  reoCrm: [1, { code: "REO", category: "CRM" }],
  moPortal: [2, { code: "MO", category: "PORTAL" }],
  dirPortal: [3, { code: "DIR", category: "PORTAL" }],
  customCrm: [4, { code: "PSG-CRM", category: "CRM" }],
  customPortal: [5, { code: "PORTAL-HELP", category: "PORTAL" }],
  customNoCategory: [6, { code: "CUSTOM1", category: undefined }],
  customBadCategory: [7, { code: "CUSTOM2", category: "STAFF" }],
  memberCrm: [8, { code: "MEMBER", category: "CRM" }], // bad data: portal role stored as CRM
  asu: [9, { code: "ASU", category: "PORTAL" }],
  nonMember: [10, { code: "NON-MEMBER", category: "PORTAL" }],
  nonMemberCrm: [11, { code: "NON-MEMBER", category: "CRM", tenantId: "6acd6119b28a863c61361ae0" }],
  reoReserved: [12, { code: "AMO", category: "PORTAL", permissions: ["profile:read", "*"] }],
  amoCrmReserved: [13, { code: "AMO", category: "CRM", permissions: ["profile:read", "*"] }],
};

const savedMode = process.env.ROLE_CLASS_MODE;
let warn;
const setMode = (m) => { if (m === undefined) delete process.env.ROLE_CLASS_MODE; else process.env.ROLE_CLASS_MODE = m; };
const classLogs = () => warn.mock.calls.filter((c) => c[0] === "[ROLE_CLASS]").map((c) => JSON.parse(c[1]));
beforeEach(() => {
  jest.spyOn(require("../models/directoryClaim.model"), "find").mockImplementation(() => ({ lean: async () => [] }));
  mockRoles.length = 0;
  for (const [n, o] of Object.values(ROLES)) {
    const r = mockRole(n, o);
    if (o.category === undefined) delete r.category;
    mockRoles.push(r);
  }
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  setMode(savedMode);
});

const check = (key, connectionType = ENTRA) => {
  const [n, o] = ROLES[key];
  return H.checkDefaultRole({ tenantId: o.tenantId || ORG_A, connectionType, roleId: id(n) }).then((r) => r.reason);
};

// [role, connection, today (off/shadow), enforce]
const MATRIX = [
  ["reoCrm", ENTRA, null, null],
  ["moPortal", ENTRA, "WRONG_TYPE", "WRONG_TYPE"], // standard staff role stored PORTAL: still out
  ["dirPortal", ENTRA, "WRONG_TYPE", "WRONG_TYPE"],
  ["customCrm", ENTRA, null, null],
  ["customPortal", ENTRA, "WRONG_TYPE", "WRONG_TYPE"],
  ["customNoCategory", ENTRA, "WRONG_TYPE", "WRONG_TYPE"],
  ["customBadCategory", ENTRA, "WRONG_TYPE", "WRONG_TYPE"],
  ["memberCrm", ENTRA, null, "WRONG_TYPE"], // the one restriction: portal role stored CRM
  ["asu", ENTRA, "PROTECTED", "PROTECTED"],
  ["reoReserved", ENTRA, "WRONG_TYPE", "WRONG_TYPE"],
  ["amoCrmReserved", ENTRA, "RESERVED_PERMISSION", "RESERVED_PERMISSION"],
  ["nonMember", B2C, null, null],
  ["nonMemberCrm", B2C, "WRONG_TYPE", "WRONG_TYPE"],
  ["moPortal", B2C, "NOT_PORTAL_DEFAULT", "NOT_PORTAL_DEFAULT"],
  ["customPortal", B2C, "NOT_PORTAL_DEFAULT", "NOT_PORTAL_DEFAULT"],
  ["memberCrm", B2C, "WRONG_TYPE", "WRONG_TYPE"],
];

describe("checkDefaultRole by mode", () => {
  test.each(MATRIX)("%s on %s: off=%p, enforce=%p", async (key, conn, today, enforced) => {
    setMode(undefined);
    const baseline = await check(key, conn);
    expect(baseline).toBe(today);
    setMode("off");
    expect(await check(key, conn)).toBe(today);
    setMode("shadow");
    expect(await check(key, conn)).toBe(today);
    setMode("enforce");
    expect(await check(key, conn)).toBe(enforced);
  });

  test("enforce never makes a role eligible that is not eligible today (every role, both connection types)", async () => {
    for (const key of Object.keys(ROLES)) {
      for (const conn of [ENTRA, B2C]) {
        setMode("off");
        const today = await check(key, conn);
        setMode("enforce");
        const enforced = await check(key, conn);
        if (today) expect(enforced).toBe(today); // ineligible today -> same reason under enforce
      }
    }
  });

  test("shadow logs only roles the class check would additionally refuse", async () => {
    setMode("shadow");
    for (const [key, conn] of MATRIX) await check(key, conn);
    const logs = classLogs();
    const refused = MATRIX.filter(([, , t, e]) => !t && e).map(([k, c]) => `${ROLES[k][1].code}@${c}`);
    expect(logs.map((l) => `${l.roleCode}@${l.connectionType}`).sort()).toEqual(refused.sort());
    expect(logs[0]).toMatchObject({
      event: "role.class.shadow",
      path: "connection-default-role",
      outcome: "default_role_would_be_refused",
      roleCode: "MEMBER",
      category: "CRM",
      roleClass: "PORTAL",
      classReason: "WRONG_TYPE",
      tenantId: "68cb..9d34",
    });
  });

  test("enforce logs the refusal as default_role_refused", async () => {
    setMode("enforce");
    await check("memberCrm", ENTRA);
    expect(classLogs()).toEqual([expect.objectContaining({ event: "role.class.enforce", outcome: "default_role_refused", roleCode: "MEMBER" })]);
  });

  test("off logs nothing", async () => {
    setMode("off");
    for (const [key, conn] of MATRIX) await check(key, conn);
    expect(classLogs()).toHaveLength(0);
  });
});

test("B2C under enforce returns today's reason for every role (only an extra class refusal is possible)", async () => {
  for (const key of Object.keys(ROLES)) {
    setMode("off");
    const today = await check(key, B2C);
    setMode("enforce");
    expect(await check(key, B2C)).toBe(today);
  }
});

describe("eligibleDefaultRoles (CRM role picker)", () => {
  const codes = async (conn) => (await H.eligibleDefaultRoles(ORG_A, conn)).map((r) => r.code).sort();

  test("Entra: off == shadow == today's list; enforce only removes the mis-stored MEMBER, adds nothing", async () => {
    setMode(undefined);
    const today = await codes(ENTRA);
    expect(today).toEqual(["MEMBER", "PSG-CRM", "REO"]);
    setMode("off");
    expect(await codes(ENTRA)).toEqual(today);
    setMode("shadow");
    expect(await codes(ENTRA)).toEqual(today);
    expect(classLogs()).toHaveLength(0); // the picker never logs
    setMode("enforce");
    const enforced = await codes(ENTRA);
    expect(enforced).toEqual(["PSG-CRM", "REO"]);
    expect(enforced.every((c) => today.includes(c))).toBe(true);
  });

  test("B2C: NON-MEMBER only, in every mode", async () => {
    for (const m of ["off", "shadow", "enforce"]) {
      setMode(m);
      expect(await codes(B2C)).toEqual(["NON-MEMBER"]);
    }
  });
});

describe("just-in-time sign-in (resolveJitDefaultRoleId)", () => {
  const jit = (key, connectionType = ENTRA) =>
    H.resolveJitDefaultRoleId({ tenantId: ORG_A, connection: { _id: "c1", connectionType, defaultRoleId: id(ROLES[key][0]) } });

  test.each([["off"], ["shadow"], ["enforce"]])("%s: an Entra connection whose default is MO (stored PORTAL) refuses JIT as today", async (m) => {
    setMode(m);
    await expect(jit("moPortal")).rejects.toMatchObject({ code: "DEFAULT_ROLE_INVALID", reason: "WRONG_TYPE" });
  });

  test.each([["off"], ["shadow"], ["enforce"]])("%s: REO (stored CRM) provisions; B2C NON-MEMBER provisions", async (m) => {
    setMode(m);
    await expect(jit("reoCrm")).resolves.toBe(id(ROLES.reoCrm[0]));
    await expect(jit("nonMember", B2C)).resolves.toBe(id(ROLES.nonMember[0]));
  });

  test.each([["off"], ["shadow"]])("%s: an Entra default of MEMBER stored CRM provisions as today", async (m) => {
    setMode(m);
    await expect(jit("memberCrm")).resolves.toBe(id(ROLES.memberCrm[0]));
  });

  test("enforce: the same MEMBER-stored-CRM default is refused (class PORTAL on an Entra connection)", async () => {
    setMode("enforce");
    await expect(jit("memberCrm")).rejects.toMatchObject({ code: "DEFAULT_ROLE_INVALID", reason: "WRONG_TYPE" });
  });
});
