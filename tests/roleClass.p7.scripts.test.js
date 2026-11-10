/**
 * P7: the three older role-assignment scripts go through the shared role-class guard
 * (helpers/roleClass.js) before any role write.
 *  - scripts/quick-assign-roles.js: behaviour (runs against mocked models): off/shadow assign as
 *    today, enforce refuses an incompatible role and leaves the user unsaved; a user stored without
 *    userType is skipped (not treated as PORTAL by the schema default).
 *  - scripts/assign-asu-role.js and scripts/assign-roles-by-subscription.js: flagged RETIRE BEFORE
 *    ROLE_CLASS_MODE=enforce (unscoped ASU lookup / direct reads of other services' databases); the
 *    guard precedes their role write (source checks: both run against live databases on load).
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const A = "68cbf7806080b4621d469d34";
const savedMode = process.env.ROLE_CLASS_MODE;
const setMode = (m) => { if (m === undefined) delete process.env.ROLE_CLASS_MODE; else process.env.ROLE_CLASS_MODE = m; };
const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

afterEach(() => {
  jest.restoreAllMocks();
  setMode(savedMode);
});

describe("quick-assign-roles", () => {
  // `roles` maps a default-role code to the role document the script will find for it.
  function run(users, roles) {
    return new Promise((resolve) => {
      jest.isolateModules(() => {
        for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
        const mg = require("mongoose"); // the isolated registry's instance, the one the script uses
        jest.spyOn(mg, "connect").mockResolvedValue();
        jest.spyOn(mg, "disconnect").mockImplementation(async () => resolve());
        const User = require("../models/user.model");
        const Role = require("../models/role.model");
        jest.spyOn(User, "find").mockResolvedValue(users);
        jest.spyOn(Role, "findOne").mockImplementation(async (q) => roles[q.code] || null);
        require("../scripts/quick-assign-roles");
      });
    });
  }
  const user = (userType) => {
    const raw = { _id: new mongoose.Types.ObjectId(), tenantId: A, userEmail: "u@example.test", roles: [] };
    if (userType !== undefined) raw.userType = userType;
    const u = require("../models/user.model").hydrate(raw);
    u.save = jest.fn(async () => u);
    return u;
  };
  const role = (code, category) => ({ _id: new mongoose.Types.ObjectId(), tenantId: A, code, category, isActive: true });
  const ROLES_OK = { REO: role("REO", "CRM"), MEMBER: role("MEMBER", "PORTAL") };

  test.each([["off"], ["shadow"], ["enforce"]])("%s: compatible defaults are assigned as today", async (m) => {
    setMode(m);
    const crm = user("CRM");
    const portal = user("PORTAL");
    await run([crm, portal], ROLES_OK);
    expect(crm.save).toHaveBeenCalled();
    expect(crm.roles.map(String)).toEqual([String(ROLES_OK.REO._id)]);
    expect(portal.roles.map(String)).toEqual([String(ROLES_OK.MEMBER._id)]);
  });

  test("enforce: an incompatible role is refused and the user is not saved; off assigns it as today", async () => {
    const custom = role("CUSTOM-X", "CRM"); // a tenant custom CRM role sitting under the MEMBER lookup
    const roles = { REO: ROLES_OK.REO, MEMBER: { ...custom, code: "PORTAL-CUSTOM", category: "CRM" } };
    setMode("enforce");
    const refused = user("PORTAL");
    await run([refused], roles);
    expect(refused.save).not.toHaveBeenCalled();
    expect(refused.roles).toHaveLength(0);
    setMode("off");
    const today = user("PORTAL");
    await run([today], roles);
    expect(today.save).toHaveBeenCalled();
  });

  test.each([["off"], ["enforce"]])("%s: a user stored without userType is skipped (not defaulted to PORTAL)", async (m) => {
    setMode(m);
    const untyped = user(undefined);
    expect(untyped.userType).toBe("PORTAL"); // what the schema default shows
    await run([untyped], ROLES_OK);
    expect(untyped.save).not.toHaveBeenCalled();
  });
});

describe("retired-before-enforce scripts: guard precedes the role write", () => {
  test("assign-asu-role: flagged, tenant-matched, guarded before push", () => {
    const s = src("scripts/assign-asu-role.js");
    expect(s).toMatch(/RETIRE BEFORE ROLE_CLASS_MODE=enforce/);
    const guard = s.indexOf("assertRoleClassAssignment({");
    const tenant = s.indexOf("String(asuRole.tenantId) !== String(user.tenantId)");
    const write = s.indexOf("user.roles.push(asuRole._id)");
    expect(guard).toBeGreaterThan(0);
    expect(tenant).toBeGreaterThan(0);
    expect(tenant).toBeLessThan(write);
    expect(guard).toBeLessThan(write);
  });

  test("assign-roles-by-subscription: flagged, guarded before the role write", () => {
    const s = src("scripts/assign-roles-by-subscription.js");
    expect(s).toMatch(/RETIRE BEFORE ROLE_CLASS_MODE=enforce/);
    const guard = s.indexOf("roleClassAllows({ user, role: targetRole");
    const write = s.indexOf("user.roles = [targetRole._id]");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(write);
  });

  test("scripts that assign roles directly outside the guard are exactly the known, reported set", () => {
    const dir = path.join(__dirname, "..", "scripts");
    const assigns = /user\.roles\s*=\s*\[\s*[^\]\s]|user\.roles\.push\(/; // a non-empty assignment (removal excluded)
    const unguarded = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".js") && assigns.test(src(`scripts/${f}`)))
      .filter((f) => !/roleClassAllows|assertRoleClassAssignment/.test(src(`scripts/${f}`)));
    // Outside the owner's list of three: reported for a decision (route or retire), unchanged here.
    expect(unguarded.sort()).toEqual([
      "assign-default-roles-to-existing-users.js",
      "migrate-constants-to-db.js",
      "migrate-constants-to-staging.js",
    ]);
  });
});
