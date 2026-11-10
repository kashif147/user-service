/**
 * P7: role-assignment scripts go through the shared role-class guard (helpers/roleClass.js) before
 * any role write, or are retired.
 *  - scripts/quick-assign-roles.js: behaviour (runs against mocked models): off/shadow assign as
 *    today, enforce refuses an incompatible role and leaves the user unsaved; a user stored without
 *    userType is skipped (not treated as PORTAL by the schema default).
 *  - the other role-writing scripts (assign-asu-role, assign-roles-by-subscription,
 *    assign-default-roles-to-existing-users, migrate-constants-to-db / -to-staging,
 *    full-staging-migration and cleanup-staging-db) are retired: absent, not required, and no script assigns roles outside
 *    the guard.
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

describe("retired role-writing scripts (P7, before enforce)", () => {
  // Bypassed the role-assignment API and the role-class guard; no npm script, CI, cron or code path
  // ran them. Replacements: ASU via the role-assignment API (Z9 own-tenant ASU rule, privilege /
  // freeze / audit / role-class guards); MEMBER / NON-MEMBER via the membership listeners and the
  // B2C sign-in membership check (helpers/portalRoleSync.js); default roles via the guarded
  // helpers/roleAssignment.js (scripts/assign-default-roles-enhanced.js).
  const RETIRED = [
    "assign-asu-role",
    "assign-roles-by-subscription",
    "assign-default-roles-to-existing-users",
    "migrate-constants-to-db",
    "migrate-constants-to-staging",
    "full-staging-migration", // only ran migrate-constants-to-staging
    "cleanup-staging-db", // only run by full-staging-migration; stripped every user's roles, deleted roles / permissions / tenants
  ];

  test.each(RETIRED)("%s is gone and not required anywhere", (name) => {
    expect(fs.existsSync(path.join(__dirname, "..", "scripts", `${name}.js`))).toBe(false);
    const roots = ["scripts", "handlers", "helpers", "controllers", "services", "routes", "rabbitMQ"];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(d, e.name))) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);
    const users = roots.flatMap((r) => walk(path.join(__dirname, "..", r)))
      .filter((f) => new RegExp(`require\\([^)]*${name}[^)]*\\)`).test(fs.readFileSync(f, "utf8")));
    expect(users).toEqual([]);
    const pkg = JSON.stringify(require("../package.json").scripts || {});
    expect(pkg.includes(name)).toBe(false);
  });

  test("no script assigns roles to users directly outside the role-class guard", () => {
    const dir = path.join(__dirname, "..", "scripts");
    const assigns = /user\.roles\s*=\s*\[\s*[^\]\s]|user\.roles\.push\(/; // a non-empty assignment (removal excluded)
    const unguarded = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".js") && assigns.test(src(`scripts/${f}`)))
      .filter((f) => !/roleClassAllows|assertRoleClassAssignment/.test(src(`scripts/${f}`)));
    expect(unguarded).toEqual([]);
  });
});
