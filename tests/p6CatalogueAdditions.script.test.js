/**
 * scripts/add-p6-catalogue-permissions.js (PDP rollout P1) - serialisation guard, set guard, collision
 * refusals, read-only dry run, ledgered apply, idempotency and ledger rollback, against an in-memory
 * catalogue (no database).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, guard, guardSet, collisions, parseArgs, readOnly, safeMessage, rowHash, PERMISSIONS, CODES } = require("../scripts/add-p6-catalogue-permissions");

function fakeCatalogue(seed) {
  let rows = seed.map((r, i) => ({ _id: `id${i}`, ...r }));
  let n = 1000;
  const writes = [];
  const Permission = {
    find: (q = {}) => ({
      lean: async () => rows.filter((r) => (q._id === undefined || r._id === q._id) && (q.code === undefined || r.code === q.code)).map((r) => ({ ...r })),
    }),
    create: async (doc) => {
      writes.push(["create", doc.code]);
      if (rows.some((r) => r.code === doc.code)) throw Object.assign(new Error("E11000 duplicate code"), { code: 11000 });
      const row = { _id: `new${n++}`, ...doc };
      rows.push(row);
      return row;
    },
    deleteOne: async ({ _id, code }) => {
      writes.push(["deleteOne", code]);
      const before = rows.length;
      rows = rows.filter((r) => !(r._id === _id && r.code === code));
      return { deletedCount: before - rows.length };
    },
    updateOne: async ({ _id, code }, { $set }) => {
      writes.push(["updateOne", code]);
      const r = rows.find((x) => x._id === _id && x.code === code);
      if (r) Object.assign(r, $set);
      return { modifiedCount: r ? 1 : 0 };
    },
    rows: () => rows,
    writes,
    mutate: (code, patch) => Object.assign(rows.find((r) => r.code === code), patch),
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
    insertOne: async () => {
      throw new Error("must not be called");
    },
  };
}
const EXISTING = [
  { code: "ACCOUNTS.REPORTS_READ", resource: "accounts.reports", action: "read", category: "ACCOUNT", level: 1, isActive: true, name: "x" },
  { code: "CRM_MEMBER_READ", resource: "crm", action: "member_read", category: "CRM", level: 1, isActive: true, name: "y" },
  { code: "NOTIFICATION_READ", resource: "Notification", action: "read", category: "CRM", level: 1, isActive: true, name: "z" },
];
const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "p6cat-"));
const exact = (p) => ({ ...p });

describe("approved definitions (§2a)", () => {
  test("exactly the nine codes, forms, categories and audiences", () => {
    expect(PERMISSIONS.map((p) => [p.code, `${p.resource}:${p.action}`, p.category, p.audience])).toEqual([
      ["PAYMENTS.BANK_READ", "payments.bank:read", "CRM", "CRM"],
      ["TENANT.AUTH_READ", "tenant.auth:read", "CRM", "CRM"],
      ["REPORTING.STATISTICS_READ", "reporting.statistics:read", "CRM", "CRM"],
      ["REPORTING.LISTINGS_READ", "reporting.listings:read", "CRM", "CRM"],
      ["REPORTING.FINANCE_READ", "reporting.finance:read", "CRM", "CRM"],
      ["REPORTING.TEMPLATES_READ", "reporting.templates:read", "CRM", "CRM"],
      ["REPORTING.TEMPLATES_WRITE", "reporting.templates:write", "CRM", "CRM"],
      ["ACCOUNTS.MEMBER_READ", "accounts.member:read", "ACCOUNT", "BOTH"],
      ["CONTACT_READ", "contact:read", "CRM", "CRM"],
    ]);
  });
  test("every code: level 1, not a system permission, active", () => {
    for (const p of PERMISSIONS) expect([p.level, p.isSystemPermission, p.isActive]).toEqual([1, false, true]);
  });
  test("no generic reporting:read / reporting:write code", () => {
    expect(PERMISSIONS.map((p) => `${p.resource}:${p.action}`)).not.toEqual(expect.arrayContaining(["reporting:read"]));
    expect(PERMISSIONS.map((p) => `${p.resource}:${p.action}`)).not.toEqual(expect.arrayContaining(["reporting:write"]));
  });
});

describe("serialisation guard", () => {
  test.each(PERMISSIONS.map((p) => [p.code, p]))("%s passes: code transform == resource:action", (_c, p) => {
    expect(guard(p)).toEqual([]);
  });
  test.each([
    ["no dot", { code: "CONTACT_READ", resource: "contact", action: "read" }],
    ["one dot", { code: "PAYMENTS.BANK_READ", resource: "payments.bank", action: "read" }],
    ["live precedent", { code: "ACCOUNTS.REPORTS_READ", resource: "accounts.reports", action: "read" }],
    ["digits", { code: "A1.B2_WRITE", resource: "a1.b2", action: "write" }],
  ])("accepts %s", (_l, p) => {
    expect(guard(p)).toEqual([]);
  });
  test("the set has no duplicate code / resource:action / token", () => {
    expect(guardSet(PERMISSIONS)).toEqual([]);
  });
  test.each([
    ["compound action", { code: "CRM_MEMBER_READ", resource: "crm", action: "member_read" }, "TOKEN_FORM_MISMATCH"],
    ["hyphen resource", { code: "ISSUES_FTP_READ", resource: "issues-ftp", action: "read" }, "TOKEN_FORM_MISMATCH"],
    ["code/resource mismatch", { code: "REPORTING_STATISTICS_READ", resource: "reporting.statistics", action: "read" }, "TOKEN_FORM_MISMATCH"],
    ["two dotted segments", { code: "A.B.C_READ", resource: "a.b.c", action: "read" }, "RESOURCE_FORMAT"],
    ["upper-case resource", { code: "CONTACT_READ", resource: "Contact", action: "read" }, "RESOURCE_FORMAT"],
    ["lower-case code", { code: "contact_read", resource: "contact", action: "read" }, "CODE_NOT_UPPERCASE"],
    ["unknown action", { code: "CONTACT_LIST", resource: "contact", action: "list" }, "ACTION_NOT_PDP_EVALUABLE"],
    ["wildcard", { code: "CONTACT_*", resource: "contact", action: "*" }, "WILDCARD"],
    ["platform namespace", { code: "PLATFORM_READ", resource: "platform", action: "read" }, "PLATFORM_NAMESPACE"],
    ["platform sub-namespace", { code: "PLATFORM.TENANT_READ", resource: "platform.tenant", action: "read" }, "PLATFORM_NAMESPACE"],
    ["two underscores", { code: "REPORTING_STATS_READ", resource: "reporting:stats", action: "read" }, "CODE_NOT_ONE_UNDERSCORE"],
    ["no underscore", { code: "CONTACT", resource: "contact", action: "read" }, "CODE_NOT_ONE_UNDERSCORE"],
    ["dotted action", { code: "CONTACT_READ.ALL", resource: "contact", action: "read.all" }, "ACTION_NOT_SINGLE_TOKEN"],
    ["leading dot", { code: ".CONTACT_READ", resource: ".contact", action: "read" }, "RESOURCE_FORMAT"],
    ["bad audience", { code: "CONTACT_READ", resource: "contact", action: "read", audience: "ALL" }, "AUDIENCE_INVALID"],
  ])("rejects %s", (_l, p, reason) => {
    expect(guard(p).join(",")).toContain(reason);
  });
  test.each([
    ["code", [{ code: "A_READ", resource: "a", action: "read" }, { code: "A_READ", resource: "b", action: "read" }], "DUPLICATE_CODE"],
    ["resource:action", [{ code: "A_READ", resource: "a", action: "read" }, { code: "B_READ", resource: "a", action: "read" }], "DUPLICATE_RESOURCE_ACTION"],
    ["token", [{ code: "A.B_READ", resource: "a.b", action: "read" }, { code: "A.B_READ ", resource: "x", action: "read" }], "DUPLICATE_TOKEN"],
  ])("set guard rejects a duplicate %s", (_l, defs, reason) => {
    expect(guardSet(defs).join(",")).toContain(reason);
  });
});

describe("collisions with the live catalogue", () => {
  test("none against a catalogue without the codes: all nine MISSING", () => {
    const r = collisions(EXISTING);
    expect(r.collisions).toEqual([]);
    expect(Object.values(r.status)).toEqual(Array(9).fill("MISSING"));
  });
  test.each([
    ["same resource:action under another code", { code: "CONTACTS_VIEW", resource: "contact", action: "read", category: "CRM", level: 1 }, /^CONFLICT contact:read/],
    ["same resource:action, different case", { code: "BANK_VIEW", resource: "Payments.Bank", action: "READ", category: "CRM", level: 1 }, /^CONFLICT payments\.bank:read/],
    ["token clash (code transform of another code)", { code: "CONTACT:READ", resource: "contactx", action: "read", category: "CRM", level: 1 }, /^TOKEN_CLASH contact:read/],
    ["existing code with different semantics", { ...exact(PERMISSIONS[8]), category: "PORTAL" }, /^EXISTS_WITH_DIFFERENT_SEMANTICS CONTACT_READ: category/],
    ["existing code with different audience", { ...exact(PERMISSIONS[7]), audience: "PORTAL" }, /^EXISTS_WITH_DIFFERENT_SEMANTICS ACCOUNTS\.MEMBER_READ: audience/],
    ["duplicated code", [exact(PERMISSIONS[0]), exact(PERMISSIONS[0])], /^DUPLICATE_CODE PAYMENTS\.BANK_READ/],
  ])("refuses on %s, nothing written", async (_l, extra, reason) => {
    const P = fakeCatalogue([...EXISTING, ...[].concat(extra)]);
    const n = P.rows().length;
    const r = await run({ Permission: P, roles: fakeRoles() }, { apply: true, outDir: outDir() });
    expect(r.ok).toBe(false);
    expect(r.collisions.join("|")).toMatch(reason);
    expect(P.rows()).toHaveLength(n);
    expect(P.writes).toEqual([]);
  });
  test("an unrelated similar code is not a clash", async () => {
    const P = fakeCatalogue([...EXISTING, { code: "CONTACTS_READ", resource: "contacts", action: "read", category: "CRM", level: 1 }]);
    const r = await run({ Permission: P, roles: fakeRoles() }, {});
    expect(r.ok).toBe(true);
    expect(r.collisions).toEqual([]);
  });
});

describe("dry run (default)", () => {
  test("plans nine inserts and writes nothing", async () => {
    const P = fakeCatalogue(EXISTING);
    const r = await run({ Permission: P, roles: fakeRoles() }, {});
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.planned).toEqual(CODES);
    expect(P.rows()).toHaveLength(3);
    expect(P.writes).toEqual([]);
  });
  test("database handles are read-only: a write method throws", async () => {
    const ro = readOnly(fakeCatalogue(EXISTING), "Permission");
    expect(() => ro.create({})).toThrow(/READ_ONLY_VIOLATION Permission.create/);
    for (const m of ["insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate", "bulkWrite"]) expect(() => ro[m]()).toThrow(/READ_ONLY_VIOLATION/);
    expect(typeof ro.find).toBe("function");
  });
  test("rollback dry run reports the plan and writes nothing", async () => {
    const P = fakeCatalogue(EXISTING);
    const dir = outDir();
    const applied = await run({ Permission: P, roles: fakeRoles() }, { apply: true, outDir: dir });
    P.writes.length = 0;
    const r = await run({ Permission: P, roles: fakeRoles() }, { rollback: applied.ledgerFile });
    expect(r.ok).toBe(true);
    expect(r.rollback.map((a) => a.action)).toEqual(Array(9).fill("DELETE"));
    expect(P.writes).toEqual([]);
    expect(P.rows()).toHaveLength(12);
  });
});

describe("CLI flags", () => {
  test("no flag = dry run; --apply must be explicit", () => {
    expect(parseArgs([])).toMatchObject({ apply: false });
    expect(parseArgs(["--dry-run"])).toMatchObject({ apply: false });
    expect(parseArgs(["--apply", "--out-dir", "/x"])).toMatchObject({ apply: true, outDir: "/x" });
    expect(parseArgs(["--rollback=/l.json"])).toMatchObject({ apply: false, rollback: "/l.json" });
    expect(parseArgs(["--rollback", "/l.json", "--apply"])).toMatchObject({ apply: true, rollback: "/l.json" });
  });
  test.each([[["--apply", "--dry-run"], /CONTRADICTORY/], [["--execute"], /UNKNOWN_ARGUMENT/], [["--rollback"], /ROLLBACK_LEDGER_REQUIRED/]])("refuses %j", (argv, re) => {
    expect(() => parseArgs(argv)).toThrow(re);
  });
  test("apply without --out-dir is refused before reading", async () => {
    const P = fakeCatalogue(EXISTING);
    const r = await run({ Permission: P, roles: fakeRoles() }, { apply: true });
    expect(r.reason).toMatch(/OUT_DIR_REQUIRED/);
    expect(P.writes).toEqual([]);
  });
  test("error output never carries a connection string", () => {
    expect(safeMessage("failed mongodb+srv://u:p@h.example/db?x=1 timeout")).toBe("failed <uri> timeout");
  });
});

describe("apply, ledger, idempotency", () => {
  test("adds exactly the nine; backup + ledger written; every existing row unchanged", async () => {
    const P = fakeCatalogue(EXISTING);
    const dir = outDir();
    const r = await run({ Permission: P, roles: fakeRoles() }, { apply: true, outDir: dir });
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(9);
    expect(r.after.added).toEqual([...CODES].sort());
    expect(r.after.preExistingUnchanged).toBe(true);
    expect(JSON.parse(fs.readFileSync(r.backupFile, "utf8")).catalogue).toHaveLength(3);
    const ledger = JSON.parse(fs.readFileSync(r.ledgerFile, "utf8"));
    expect(ledger.status).toBe("applied");
    expect(ledger.planned).toEqual(CODES);
    expect(ledger.inserted.map((i) => i.code)).toEqual(CODES);
    const stored = P.rows().filter((x) => CODES.includes(x.code));
    expect(stored.map((x) => x.audience)).toEqual(PERMISSIONS.map((p) => p.audience));
    expect(stored.every((x) => x.createdBy === "script:add-p6-catalogue-permissions")).toBe(true);
  });
  test("idempotent: a second run inserts nothing and reports PRESENT", async () => {
    const P = fakeCatalogue(EXISTING);
    await run({ Permission: P, roles: fakeRoles() }, { apply: true, outDir: outDir() });
    const r = await run({ Permission: P, roles: fakeRoles() }, { apply: true, outDir: outDir() });
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(0);
    expect(Object.values(r.permissions)).toEqual(Array(9).fill("PRESENT"));
    expect(P.rows()).toHaveLength(12);
  });
  test("a backup / ledger file is never overwritten", async () => {
    const P = fakeCatalogue(EXISTING);
    const dir = outDir();
    const now = () => new Date("2026-11-04T00:00:00.000Z");
    await run({ Permission: P, roles: fakeRoles() }, { apply: true, outDir: dir, now });
    const P2 = fakeCatalogue(EXISTING);
    await expect(run({ Permission: P2, roles: fakeRoles() }, { apply: true, outDir: dir, now })).rejects.toThrow(/EEXIST/);
    expect(P2.writes).toEqual([]);
  });
});

describe("rollback", () => {
  test("deletes unreferenced unmodified inserts, deactivates referenced ones, keeps modified ones", async () => {
    const P = fakeCatalogue(EXISTING);
    const applied = await run({ Permission: P, roles: fakeRoles() }, { apply: true, outDir: outDir() });
    P.mutate("CONTACT_READ", { description: "x", name: "Edited" });
    const roles = fakeRoles([{ code: "MO", permissions: ["REPORTING.STATISTICS_READ"] }]);
    const r = await run({ Permission: P, roles }, { rollback: applied.ledgerFile, apply: true });
    const byCode = Object.fromEntries(r.rollback.map((a) => [a.code, a.action]));
    expect(byCode["REPORTING.STATISTICS_READ"]).toBe("DEACTIVATE");
    expect(byCode.CONTACT_READ).toBe("KEPT_MODIFIED");
    expect(r.deleted).toBe(7);
    expect(r.deactivated).toBe(1);
    const left = P.rows().map((x) => x.code).sort();
    expect(left).toEqual(["ACCOUNTS.REPORTS_READ", "CONTACT_READ", "CRM_MEMBER_READ", "NOTIFICATION_READ", "REPORTING.STATISTICS_READ"]);
    expect(P.rows().find((x) => x.code === "REPORTING.STATISTICS_READ").isActive).toBe(false);
    // pre-existing rows untouched
    expect(P.rows().filter((x) => !CODES.includes(x.code))).toEqual(fakeCatalogue(EXISTING).rows());
  });
  test("refuses a ledger from another script or naming a code outside the nine", async () => {
    const dir = outDir();
    const foreign = path.join(dir, "l1.json");
    fs.writeFileSync(foreign, JSON.stringify({ script: "other", inserted: [] }));
    const outside = path.join(dir, "l2.json");
    fs.writeFileSync(outside, JSON.stringify({ script: "add-p6-catalogue-permissions", inserted: [{ id: "id0", code: "ACCOUNTS.REPORTS_READ", hash: rowHash(EXISTING[0]) }] }));
    const P = fakeCatalogue(EXISTING);
    expect((await run({ Permission: P, roles: fakeRoles() }, { rollback: foreign, apply: true })).reason).toMatch(/LEDGER_NOT_FROM_THIS_SCRIPT/);
    expect((await run({ Permission: P, roles: fakeRoles() }, { rollback: outside, apply: true })).reason).toMatch(/LEDGER_CODE_OUTSIDE_SCOPE/);
    expect(P.writes).toEqual([]);
  });
});
