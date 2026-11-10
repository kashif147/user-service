/**
 * P7 role / user-type compatibility: helpers/roleClass.js on its own.
 *  - ROLE_CLASS_BY_CODE equals the #39 new-tenant manifest classes (fixture taken from b33fc00, sha256
 *    recorded), and the committed config/tenantRoles.v1.json once #39 is merged.
 *  - Standard codes ignore the stored category; custom roles use it; missing / unknown categories and
 *    missing / unknown user types are compatible with nothing.
 *  - ROLE_CLASS_MODE parsing: default off, unknown value -> off.
 */
const fs = require("fs");
const path = require("path");
const RC = require("../helpers/roleClass");

const fixture = require("./fixtures/p7-manifest39-role-classes.json");

describe("standard-role class map vs #39 manifest", () => {
  test("the fixture is #39 at b33fc00 (recorded manifest hash)", () => {
    expect(fixture.commit).toBe("b33fc00");
    expect(fixture.sha256).toBe("93b75171b7d7b8686e550b4175b32c70024f7910838197554de739ef0b879ca7");
    expect(Object.keys(fixture.classes)).toHaveLength(24);
  });

  test("ROLE_CLASS_BY_CODE has exactly the manifest codes and classes", () => {
    expect(RC.ROLE_CLASS_BY_CODE).toEqual(fixture.classes);
  });

  test("manifest shape: 21 CRM, 2 PORTAL (MEMBER, NON-MEMBER), 1 SYSTEM (ASU)", () => {
    const by = (c) => Object.entries(RC.ROLE_CLASS_BY_CODE).filter(([, v]) => v === c).map(([k]) => k).sort();
    expect(by("CRM")).toHaveLength(21);
    expect(by("PORTAL")).toEqual(["MEMBER", "NON-MEMBER"]);
    expect(by("SYSTEM")).toEqual(["ASU"]);
  });

  test("when #39's config/tenantRoles.v1.json is present, the map matches it too", () => {
    const file = path.join(__dirname, "..", "config", "tenantRoles.v1.json");
    if (!fs.existsSync(file)) return; // #39 is held: not on develop yet
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const classes = Object.fromEntries(manifest.roles.map((r) => [r.code, r.category]));
    expect(RC.ROLE_CLASS_BY_CODE).toEqual(classes);
  });
});

describe("roleClassOf", () => {
  test("standard codes use the map whatever the stored category (case/space-insensitive)", () => {
    expect(RC.roleClassOf({ code: "MO", category: "PORTAL" })).toEqual({ roleClass: "CRM", source: "standard", problem: null });
    expect(RC.roleClassOf({ code: " reo ", category: "PORTAL" }).roleClass).toBe("CRM");
    expect(RC.roleClassOf({ code: "MEMBER", category: "CRM" }).roleClass).toBe("PORTAL");
    expect(RC.roleClassOf({ code: "ASU", category: "PORTAL" }).roleClass).toBe("SYSTEM");
    expect(RC.roleClassOf({ code: "MO" }).problem).toBeNull(); // no category needed
  });

  test("custom roles use the stored category", () => {
    expect(RC.roleClassOf({ code: "PSG-CRM", category: "CRM" })).toEqual({ roleClass: "CRM", source: "category", problem: null });
    expect(RC.roleClassOf({ code: "X1", category: " portal " }).roleClass).toBe("PORTAL");
    expect(RC.roleClassOf({ code: "X2", category: "SYSTEM" }).roleClass).toBe("SYSTEM");
  });

  test.each([undefined, null, "", "   "])("custom role with category %p -> CATEGORY_MISSING", (category) => {
    expect(RC.roleClassOf({ code: "X", category })).toEqual({ roleClass: null, source: "category", problem: "CATEGORY_MISSING" });
  });

  test.each(["STAFF", "ADMIN", "crm-ish"])("custom role with category %p -> CATEGORY_UNKNOWN", (category) => {
    expect(RC.roleClassOf({ code: "X", category })).toEqual({ roleClass: null, source: "category", problem: "CATEGORY_UNKNOWN" });
  });

  test("a role without a code is custom", () => {
    expect(RC.roleClassOf({ category: "CRM" }).source).toBe("category");
    expect(RC.roleClassOf({}).problem).toBe("CATEGORY_MISSING");
  });
});

describe("incompatibility", () => {
  test.each([
    ["CRM", { code: "MO", category: "PORTAL" }, null],
    ["CRM", { code: "ASU" }, null],
    ["CRM", { code: "C1", category: "SYSTEM" }, null],
    ["CRM", { code: "MEMBER", category: "CRM" }, "ROLE_CLASS_MISMATCH"],
    ["CRM", { code: "C2", category: "PORTAL" }, "ROLE_CLASS_MISMATCH"],
    ["PORTAL", { code: "MEMBER" }, null],
    ["PORTAL", { code: "NON-MEMBER" }, null],
    ["PORTAL", { code: "ASU" }, "ROLE_CLASS_MISMATCH"],
    ["PORTAL", { code: "REO", category: "PORTAL" }, "ROLE_CLASS_MISMATCH"],
    ["PORTAL", { code: "C3", category: "PORTAL" }, null],
    ["portal", { code: "MEMBER" }, null],
    ["CRM", { code: "C4" }, "CATEGORY_MISSING"],
    ["PORTAL", { code: "C5", category: "WEIRD" }, "CATEGORY_UNKNOWN"],
  ])("%s user + %j -> %p", (userType, role, expected) => {
    expect(RC.incompatibility(userType, role)).toBe(expected);
  });

  test.each([undefined, null, "", " "])("user type %p -> USER_TYPE_MISSING for every role", (userType) => {
    expect(RC.incompatibility(userType, { code: "MEMBER" })).toBe("USER_TYPE_MISSING");
    expect(RC.incompatibility(userType, { code: "MO" })).toBe("USER_TYPE_MISSING");
  });

  test.each(["ADMIN", "SYSTEM", "B2C"])("user type %p -> USER_TYPE_UNKNOWN for every role", (userType) => {
    expect(RC.incompatibility(userType, { code: "MEMBER" })).toBe("USER_TYPE_UNKNOWN");
    expect(RC.incompatibility(userType, { code: "ASU" })).toBe("USER_TYPE_UNKNOWN");
  });

  test("partitionRoles keeps order, skips null entries", () => {
    const roles = [{ code: "MO" }, null, { code: "MEMBER" }, { code: "ASU" }];
    const { compatible, incompatible } = RC.partitionRoles("CRM", roles);
    expect(compatible.map((r) => r.code)).toEqual(["MO", "ASU"]);
    expect(incompatible).toEqual([{ role: { code: "MEMBER" }, reason: "ROLE_CLASS_MISMATCH" }]);
  });
});

describe("ROLE_CLASS_MODE", () => {
  const saved = process.env.ROLE_CLASS_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ROLE_CLASS_MODE;
    else process.env.ROLE_CLASS_MODE = saved;
  });

  test("unset or blank -> off", () => {
    delete process.env.ROLE_CLASS_MODE;
    expect(RC.roleClassMode()).toBe("off");
    process.env.ROLE_CLASS_MODE = "  ";
    expect(RC.roleClassMode()).toBe("off");
  });

  test("off / shadow / enforce, case-insensitive", () => {
    for (const [raw, mode] of [["off", "off"], ["SHADOW", "shadow"], [" Enforce ", "enforce"]]) {
      process.env.ROLE_CLASS_MODE = raw;
      expect(RC.roleClassMode()).toBe(mode);
    }
  });

  test("unknown value -> off (rollback-safe), warned once", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ROLE_CLASS_MODE = "on";
    expect(RC.roleClassMode()).toBe("off");
    expect(RC.roleClassMode()).toBe("off");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("ROLE_CLASS_MODE"))).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("assertRoleClassAssignment", () => {
  const saved = process.env.ROLE_CLASS_MODE;
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => {
    warn.mockRestore();
    if (saved === undefined) delete process.env.ROLE_CLASS_MODE;
    else process.env.ROLE_CLASS_MODE = saved;
  });
  const user = { _id: "c00000000000000000000001", tenantId: "68cbf7806080b4621d469d34", userType: "PORTAL" };
  const roles = [{ code: "MEMBER" }, { code: "MO" }];

  test("off: no evaluation, no log", () => {
    process.env.ROLE_CLASS_MODE = "off";
    expect(() => RC.assertRoleClassAssignment({ user, roles, path: "t" })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  test("shadow: logs what enforce would refuse, masked ids, no throw", () => {
    process.env.ROLE_CLASS_MODE = "shadow";
    expect(() => RC.assertRoleClassAssignment({ user, roles, path: "t" })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(warn.mock.calls[0][1]);
    expect(line).toMatchObject({
      event: "role.class.shadow",
      outcome: "assignment_would_be_refused",
      tenantId: "68cb..9d34",
      userId: "c000..0001",
      userType: "PORTAL",
      roles: [{ roleCode: "MO", roleClass: "CRM", reason: "ROLE_CLASS_MISMATCH" }],
    });
  });

  test("enforce: throws 409 ROLE_CLASS_INCOMPATIBLE with per-role details", () => {
    process.env.ROLE_CLASS_MODE = "enforce";
    let err;
    try { RC.assertRoleClassAssignment({ user, roles, path: "t" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RC.RoleClassError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("ROLE_CLASS_INCOMPATIBLE");
    expect(err.details).toEqual([{ roleCode: "MO", roleClass: "CRM", reason: "ROLE_CLASS_MISMATCH" }]);
  });

  test("enforce: all-compatible roles pass silently", () => {
    process.env.ROLE_CLASS_MODE = "enforce";
    expect(() => RC.assertRoleClassAssignment({ user, roles: [{ code: "MEMBER" }], path: "t" })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  test("roleClassAllows is the boolean form", () => {
    process.env.ROLE_CLASS_MODE = "enforce";
    expect(RC.roleClassAllows({ user, role: { code: "MO" }, path: "t" })).toBe(false);
    expect(RC.roleClassAllows({ user, role: { code: "MEMBER" }, path: "t" })).toBe(true);
    process.env.ROLE_CLASS_MODE = "shadow";
    expect(RC.roleClassAllows({ user, role: { code: "MO" }, path: "t" })).toBe(true);
  });
});
