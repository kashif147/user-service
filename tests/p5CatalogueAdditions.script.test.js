/**
 * scripts/add-p5-catalogue-permissions.js - serialisation guard, additive-only behaviour, refusals,
 * idempotency and rollback, against an in-memory catalogue (no database).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, guard, PERMISSIONS, CODES } = require("../scripts/add-p5-catalogue-permissions");

function fakeCatalogue(seed) {
  let rows = seed.map((r, i) => ({ _id: `id${i}`, ...r }));
  let n = 1000;
  const Permission = {
    find: () => ({ lean: async () => rows.map((r) => ({ ...r })) }),
    create: async (doc) => {
      if (rows.some((r) => r.code === doc.code)) throw new Error("E11000 duplicate code");
      rows.push({ _id: `new${n++}`, ...doc });
    },
    deleteOne: async ({ _id, code }) => {
      const before = rows.length;
      rows = rows.filter((r) => !(r._id === _id && r.code === code));
      return { deletedCount: before - rows.length };
    },
    rows: () => rows,
  };
  return Permission;
}
function fakeRoles(roleDocs = []) {
  return {
    find: (q) => ({
      project: () => ({
        toArray: async () => roleDocs.filter((r) => (r.permissions || []).some((p) => q.permissions.$in.map(String).includes(String(p)))),
      }),
    }),
  };
}
const EXISTING = [
  { code: "EVENTS_READ", resource: "events", action: "read", category: "CRM", level: 1, isSystemPermission: true, isActive: true, name: "x" },
  { code: "CRM_MEMBER_READ", resource: "crm", action: "member_read", category: "CRM", level: 1, isActive: true, name: "y" },
];
const backupPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p5cat-")), "before.json");

describe("serialisation guard", () => {
  test.each(PERMISSIONS.map((p) => [p.code, p]))("%s passes: token form == PDP form", (_c, p) => {
    expect(guard(p)).toEqual([]);
  });
  test("exact approved definitions", () => {
    expect(PERMISSIONS.map((p) => [p.code, `${p.resource}:${p.action}`, p.category])).toEqual([
      ["REGISTRATIONS_CREATE", "registrations:create", "PORTAL"],
      ["REGISTRATIONS_READ", "registrations:read", "PORTAL"],
      ["REGISTRATIONS_WRITE", "registrations:write", "PORTAL"],
      ["DIRECTORY_READ", "directory:read", "CRM"],
    ]);
  });
  test.each([
    ["compound action", { code: "CRM_MEMBER_READ", resource: "crm", action: "member_read" }, "TOKEN_FORM_MISMATCH"],
    ["hyphen resource", { code: "ISSUES_FTP_READ", resource: "issues-ftp", action: "read" }, "TOKEN_FORM_MISMATCH"],
    ["prefix code", { code: "CRM_MEMBER_DIRECTORY_READ", resource: "directory", action: "read" }, "TOKEN_FORM_MISMATCH"],
    ["unknown action", { code: "DIRECTORY_LIST", resource: "directory", action: "list" }, "ACTION_NOT_PDP_EVALUABLE"],
    ["platform namespace", { code: "PLATFORM_READ", resource: "platform", action: "read" }, "PLATFORM_NAMESPACE"],
  ])("rejects %s", (_l, p, reason) => {
    expect(guard(p).join(",")).toContain(reason);
  });
});

describe("run", () => {
  test("dry run writes nothing", async () => {
    const P = fakeCatalogue(EXISTING);
    const r = await run({ Permission: P, roles: fakeRoles() }, {});
    expect(r.ok).toBe(true);
    expect(P.rows()).toHaveLength(2);
    expect(Object.values(r.permissions)).toEqual(["MISSING", "MISSING", "MISSING", "MISSING"]);
  });

  test("execute requires a backup", async () => {
    const r = await run({ Permission: fakeCatalogue(EXISTING), roles: fakeRoles() }, { execute: true });
    expect(r.reason).toMatch(/BACKUP_REQUIRED/);
  });

  test("execute adds exactly the four codes and leaves every existing row unchanged", async () => {
    const P = fakeCatalogue(EXISTING);
    const b = backupPath();
    const r = await run({ Permission: P, roles: fakeRoles() }, { execute: true, backup: b });
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(4);
    expect(r.after.added).toEqual([...CODES].sort());
    expect(r.after.preExistingUnchanged).toBe(true);
    expect(r.after.count).toBe(r.before.count + 4);
    expect(JSON.parse(fs.readFileSync(b, "utf8")).catalogue).toHaveLength(2);
  });

  test("idempotent: a second run inserts nothing", async () => {
    const P = fakeCatalogue(EXISTING);
    await run({ Permission: P, roles: fakeRoles() }, { execute: true, backup: backupPath() });
    const r = await run({ Permission: P, roles: fakeRoles() }, { execute: true, backup: backupPath() });
    expect(r.inserted).toBe(0);
    expect(Object.values(r.permissions)).toEqual(["PRESENT", "PRESENT", "PRESENT", "PRESENT"]);
  });

  test.each([
    ["same resource:action under another code", { code: "DIR_VIEW", resource: "directory", action: "read", category: "CRM", level: 1 }, /CONFLICT/],
    ["existing code with different semantics", { code: "DIRECTORY_READ", resource: "directory", action: "read", category: "PORTAL", level: 1, isSystemPermission: true, isActive: true, name: "Read User Directory" }, /EXISTS_WITH_DIFFERENT_SEMANTICS/],
    ["token clash", { code: "REGISTRATIONS_READ_X", resource: "registrationsx", action: "read", category: "PORTAL", level: 1 }, null],
  ])("refuses on %s", async (_l, extra, reason) => {
    const P = fakeCatalogue([...EXISTING, extra]);
    const r = await run({ Permission: P, roles: fakeRoles() }, { execute: true, backup: backupPath() });
    if (reason) {
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(reason);
      expect(P.rows()).toHaveLength(3);
    } else {
      expect(r.ok).toBe(true); // an unrelated similar code is not a clash
    }
  });

  test("remove refuses while a role references a code, otherwise deletes exactly the four", async () => {
    const P = fakeCatalogue(EXISTING);
    await run({ Permission: P, roles: fakeRoles() }, { execute: true, backup: backupPath() });
    const blocked = await run({ Permission: P, roles: fakeRoles([{ code: "MEMBER", permissions: ["REGISTRATIONS_READ"] }]) }, { remove: true, execute: true, backup: backupPath() });
    expect(blocked.reason).toMatch(/REFERENCED_BY_ROLES/);
    expect(P.rows()).toHaveLength(6);
    const ok = await run({ Permission: P, roles: fakeRoles() }, { remove: true, execute: true, backup: backupPath() });
    expect(ok.deleted).toBe(4);
    expect(P.rows().map((r) => r.code).sort()).toEqual(["CRM_MEMBER_READ", "EVENTS_READ"]);
  });
});
