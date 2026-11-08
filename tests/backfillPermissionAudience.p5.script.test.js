/**
 * PDP rollout P5 - scripts/backfill-permission-audience.js. In-memory fake `permissions` collection; no database.
 * Plan (mapped / LEGACY / inactive untouched / platform untouched), every refusal, fingerprints, read-only dry run,
 * backup + ledger before the first update, guarded updates, exact rollback round-trip.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../scripts/backfill-permission-audience");
const SNAPSHOT = require("./fixtures/p4-dev-audience-snapshot.json");
const { PROPOSED_AUDIENCE } = require("../constants/permissionAudience");

const MAP = Object.freeze({ PROFILE_READ: "CRM", EVENTS_READ: "BOTH", PORTAL_READ: "PORTAL", ACCOUNTS_REPORTS: "CRM", "ACCOUNTS.REPORTS_READ": "CRM" });
const base = () => [
  { _id: "id-1", code: "PROFILE_READ", resource: "profile", action: "read", category: "PROFILE", isActive: true },
  { _id: "id-2", code: "EVENTS_READ", resource: "events", action: "read", category: "CRM", isActive: true },
  { _id: "id-3", code: "PORTAL_READ", resource: "portal", action: "read", category: "PORTAL", isActive: true },
  { _id: "id-4", code: "ACCOUNTS.REPORTS_READ", resource: "accounts.reports", action: "read", category: "ACCOUNT", isActive: true },
  { _id: "id-5", code: "ACCOUNTS_REPORTS", resource: "accounts.reports", action: "read", category: "PORTAL", isActive: true },
  { _id: "id-6", code: "MENU_FINANCE_ACCESS", resource: "menu", action: "finance_access", category: "FINANCIAL", isActive: true },
  { _id: "id-7", code: "CONTACT_READ", resource: "contact", action: "read", category: "CRM", audience: "CRM", isActive: true },
  { _id: "id-8", code: "OLD_TEST", resource: "test", action: "read", category: "PORTAL", isActive: false },
];
const MAP2 = { ...MAP, CONTACT_READ: "CRM" };

function fakeCollection(docs) {
  const rows = docs.map((d) => ({ ...d }));
  const writes = [];
  const matches = (d, f) =>
    Object.entries(f).every(([k, v]) => {
      if (v && typeof v === "object" && "$exists" in v) return v.$exists ? d[k] !== undefined : d[k] === undefined;
      return String(d[k]) === String(v);
    });
  return {
    rows,
    writes,
    find: (f = {}) => ({ toArray: async () => rows.filter((d) => matches(d, f)).map((d) => ({ ...d })) }),
    updateOne: async (f, u) => {
      writes.push({ f, u });
      const d = rows.find((x) => matches(x, f));
      if (!d) return { matchedCount: 0, modifiedCount: 0 };
      if (u.$set) Object.assign(d, u.$set);
      if (u.$unset) for (const k of Object.keys(u.$unset)) delete d[k];
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "p5-backfill-"));
const now = () => new Date("2026-11-08T17:00:00Z");

describe("plan", () => {
  test("mapped codes get their audience, every other ACTIVE row LEGACY, inactive rows untouched", () => {
    const p = S.plan(base(), MAP2);
    const by = Object.fromEntries(p.rows.map((r) => [r.code, r]));
    expect(by.PROFILE_READ.planned).toBe("CRM");
    expect(by.EVENTS_READ.planned).toBe("BOTH");
    expect(by.PORTAL_READ.planned).toBe("PORTAL");
    expect(by.MENU_FINANCE_ACCESS.planned).toBe("LEGACY");
    expect(by.OLD_TEST).toBeUndefined();
    expect(by.CONTACT_READ).toMatchObject({ current: "CRM", planned: "CRM", change: "unchanged" });
    expect(by.PROFILE_READ).toMatchObject({ current: "ABSENT", change: "change" });
    expect(p.counts).toMatchObject({ CRM: 4, BOTH: 1, PORTAL: 1, LEGACY: 1, change: 6, unchanged: 1, inactive: 1 });
    expect(p.refusals).toEqual([]);
    expect(p.aliasGroups).toEqual([{ resourceAction: "accounts.reports:read", codes: ["ACCOUNTS.REPORTS_READ", "ACCOUNTS_REPORTS"], planned: ["CRM"] }]);
  });

  test("fingerprints are deterministic, order-independent, and before !== predicted-after", () => {
    const a = S.plan(base(), MAP2);
    const b = S.plan(base().reverse(), MAP2);
    expect(a.before).toBe(b.before);
    expect(a.predictedAfter).toBe(b.predictedAfter);
    expect(a.before).not.toBe(a.predictedAfter);
  });

  test.each([
    ["STORED_CONFLICT", (c) => { c[6].audience = "BOTH"; return [c, MAP2]; }],
    ["ALIAS_CONFLICT", (c) => [c, { ...MAP2, ACCOUNTS_REPORTS: "PORTAL" }]],
    ["ALIAS_CONFLICT", (c) => [c, Object.fromEntries(Object.entries(MAP2).filter(([k]) => k !== "ACCOUNTS_REPORTS"))]],
    ["INVALID_PLANNED_VALUE", (c) => [c, { ...MAP2, PROFILE_READ: "ADMIN" }]],
    ["MAP_CODE_MISSING", (c) => [c, { ...MAP2, NO_SUCH_CODE: "CRM" }]],
    ["MAP_CODE_MISSING", (c) => [c, { ...MAP2, OLD_TEST: "CRM" }]],
    ["DUPLICATE_CODE", (c) => [[...c, { ...c[0], _id: "id-9" }], MAP2]],
    ["PLATFORM_NAMESPACE", (c) => [[...c, { _id: "id-10", code: "PLATFORM_TENANT_READ", resource: "platform", action: "read", category: "ADMIN", isActive: true }], { ...MAP2, PLATFORM_TENANT_READ: "CRM" }]],
  ])("refusal %s", (reason, mut) => {
    const [cat, map] = mut(base());
    const p = S.plan(cat, map);
    expect(p.refusals.some((r) => r.startsWith(reason))).toBe(true);
  });

  test("an unmapped platform-namespace row is never planned, only reported", () => {
    const p = S.plan([...base(), { _id: "id-10", code: "PLATFORM_TENANT_READ", resource: "platform", action: "read", category: "ADMIN", isActive: true }], MAP2);
    expect(p.rows.find((r) => r.code === "PLATFORM_TENANT_READ")).toBeUndefined();
    expect(p.skipped.platform).toEqual(["PLATFORM_TENANT_READ"]);
    expect(p.refusals).toEqual([]);
  });

  test("the real proposal map against the DEV snapshot: no refusal; every active row classified", () => {
    const cat = SNAPSHOT.catalogue.map((d, i) => ({ _id: `s-${i}`, ...d }));
    const p = S.plan(cat, PROPOSED_AUDIENCE);
    expect(p.refusals).toEqual([]);
    const active = cat.filter((d) => d.isActive).length;
    expect(p.rows).toHaveLength(active);
    expect(p.counts.CRM + p.counts.BOTH + p.counts.PORTAL + p.counts.LEGACY).toBe(active);
    expect(p.counts).toMatchObject({ CRM: 60, BOTH: 6, PORTAL: 7, LEGACY: active - 73, unchanged: 9 });
  });
});

describe("run", () => {
  test("dry run (default) is read-only: a write through the wrapped handle throws, nothing changes", async () => {
    const col = fakeCollection(base());
    const r = await S.run({ permissions: col }, { map: MAP2 });
    expect(r.ok).toBe(true);
    expect(col.writes).toHaveLength(0);
    const wrapped = S.readOnly(col, "permissions");
    expect(() => wrapped.updateOne({}, {})).toThrow(/READ_ONLY_VIOLATION/);
    expect(S.catalogueFingerprint(col.rows)).toBe(S.catalogueFingerprint(base()));
  });

  test("a refusal writes nothing even with --apply", async () => {
    const col = fakeCollection(base());
    const dir = tmp();
    const r = await S.run({ permissions: col }, { apply: true, outDir: dir, map: { ...MAP2, NO_SUCH_CODE: "CRM" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("MAP_CODE_MISSING");
    expect(col.writes).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("--apply: backup + ledger exist before the first update; result matches the predicted fingerprint", async () => {
    const col = fakeCollection(base());
    const dir = tmp();
    const orig = col.updateOne;
    let filesAtFirstWrite = null;
    col.updateOne = async (...a) => { if (filesAtFirstWrite === null) filesAtFirstWrite = fs.readdirSync(dir).sort(); return orig(...a); };
    const p = S.plan(base(), MAP2);
    const r = await S.run({ permissions: col }, { apply: true, outDir: dir, map: MAP2, now });
    expect(filesAtFirstWrite).toHaveLength(2);
    expect(filesAtFirstWrite.some((f) => f.includes("-backup-")) && filesAtFirstWrite.some((f) => f.includes("-ledger-"))).toBe(true);
    expect(r).toMatchObject({ ok: true, updated: 6, skippedConcurrent: [] });
    expect(S.catalogueFingerprint(col.rows)).toBe(p.predictedAfter);
    for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    // never overwrites: a second run in the same second refuses to reuse the file names
    await expect(S.run({ permissions: fakeCollection(base()) }, { apply: true, outDir: dir, map: MAP2, now })).rejects.toThrow(/EEXIST/);
  });

  test("guarded update: a row changed concurrently is skipped, reported, and the run flags verification errors", async () => {
    const col = fakeCollection(base());
    const orig = col.updateOne;
    col.updateOne = async (f, u) => { if (f.code === "EVENTS_READ") col.rows.find((d) => d.code === "EVENTS_READ").audience = "CRM"; return orig(f, u); };
    const r = await S.run({ permissions: col }, { apply: true, outDir: tmp(), map: MAP2, now });
    expect(r.skippedConcurrent).toEqual(["EVENTS_READ"]);
    expect(r.ok).toBe(false);
    expect(col.rows.find((d) => d.code === "EVENTS_READ").audience).toBe("CRM");
  });

  test("rollback round-trip restores the original fingerprint exactly ($unset where ABSENT, $set where it existed)", async () => {
    const original = base();
    original[1].audience = undefined;
    const col = fakeCollection(original);
    const dir = tmp();
    const applied = await S.run({ permissions: col }, { apply: true, outDir: dir, map: MAP2, now });
    expect(applied.ok).toBe(true);
    const dry = await S.run({ permissions: col }, { rollback: applied.ledgerFile });
    expect(dry.ok).toBe(true);
    expect(dry.rollback.every((a) => a.action === "UNSET")).toBe(true);
    expect(S.catalogueFingerprint(col.rows)).toBe(applied.after.fingerprint); // dry run changed nothing
    const rb = await S.run({ permissions: col }, { rollback: applied.ledgerFile, apply: true });
    expect(rb.ok).toBe(true);
    expect(rb.restored).toBe(6);
    expect(S.catalogueFingerprint(col.rows)).toBe(S.catalogueFingerprint(original));
    expect(col.rows.find((d) => d.code === "CONTACT_READ").audience).toBe("CRM"); // unchanged row untouched
  });

  test("rollback leaves a row that was modified after the back-fill alone", async () => {
    const col = fakeCollection(base());
    const applied = await S.run({ permissions: col }, { apply: true, outDir: tmp(), map: MAP2, now });
    col.rows.find((d) => d.code === "MENU_FINANCE_ACCESS").audience = "CRM";
    const rb = await S.run({ permissions: col }, { rollback: applied.ledgerFile, apply: true });
    expect(rb.rollback.find((a) => a.code === "MENU_FINANCE_ACCESS").action).toBe("KEPT_MODIFIED");
    expect(col.rows.find((d) => d.code === "MENU_FINANCE_ACCESS").audience).toBe("CRM");
  });

  test("--export writes the proposed active catalogue (no ids)", async () => {
    const f = path.join(tmp(), "proposed.json");
    await S.run({ permissions: fakeCollection(base()) }, { map: MAP2, exportFile: f, now });
    const e = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(e.catalogue).toHaveLength(7);
    expect(e.catalogue.every((r) => !("_id" in r) && !("id" in r))).toBe(true);
    expect(e.catalogue.find((r) => r.code === "MENU_FINANCE_ACCESS").audience).toBe("LEGACY");
  });

  test("parseArgs refuses unknown / contradictory flags", () => {
    expect(() => S.parseArgs(["--apply", "--dry-run"])).toThrow(/CONTRADICTORY/);
    expect(() => S.parseArgs(["--nope"])).toThrow(/UNKNOWN_ARGUMENT/);
    expect(() => S.parseArgs(["--rollback"])).toThrow(/ROLLBACK_LEDGER_REQUIRED/);
    expect(S.parseArgs(["--export", "x.json"]).exportFile).toBe("x.json");
  });
});
