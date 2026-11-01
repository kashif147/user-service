/**
 * P5 - the committed tenant-roles manifest (config/tenantRoles.v1.json) and its validator
 * (services/tenantRoleManifest.js). Pure: no database. The DB behaviour is tests/tenantRoles.p5.db.test.js.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadManifest, manifestProblems, validateManifest, MANIFEST_PATH } = require("../services/tenantRoleManifest");

const raw = fs.readFileSync(MANIFEST_PATH);
const { manifest, sha256, version } = loadManifest();
const byCode = Object.fromEntries(manifest.roles.map((r) => [r.code, r]));
const clone = () => JSON.parse(JSON.stringify(manifest));

describe("committed tenantRoles.v1.json", () => {
  test("identity = version 1 + sha256 of the raw bytes", () => {
    expect(version).toBe(1);
    expect(sha256).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
    expect(manifest.kind).toBe("user-service:tenant-roles");
  });

  test("24 tenant roles: ASU + staff + MEMBER / NON-MEMBER; no SU, NOTIFIER or AI", () => {
    expect(manifest.roles).toHaveLength(24);
    expect(Object.keys(byCode)).toEqual(expect.arrayContaining(["ASU", "MEMBER", "NON-MEMBER", "REO", "MO", "GS", "DGS"]));
    for (const c of ["SU", "NOTIFIER", "AI"]) expect(byCode[c]).toBeUndefined();
  });

  test("categories (D7): ASU SYSTEM, MEMBER / NON-MEMBER PORTAL, every other role CRM; exactly one tenant admin", () => {
    for (const r of manifest.roles) {
      const want = r.code === "ASU" ? "SYSTEM" : ["MEMBER", "NON-MEMBER"].includes(r.code) ? "PORTAL" : "CRM";
      expect({ code: r.code, category: r.category }).toEqual({ code: r.code, category: want });
      expect({ code: r.code, tenantAdmin: r.tenantAdmin, isSystemRole: r.isSystemRole }).toEqual({ code: r.code, tenantAdmin: r.code === "ASU", isSystemRole: r.code === "ASU" });
    }
  });

  test("D6: no role holds TENANT_DELETE; ASU keeps TENANT_READ + TENANT_ADMIN", () => {
    expect(manifest.roles.filter((r) => r.permissions.includes("TENANT_DELETE")).map((r) => r.code)).toEqual([]);
    expect(byCode.ASU.permissions).toEqual(expect.arrayContaining(["TENANT_ADMIN", "TENANT_READ"]));
  });

  test("D4: REO is read-only (no create / write / delete / admin / update / send code)", () => {
    expect(byCode.REO.permissions.filter((p) => /_(CREATE|WRITE|DELETE|ADMIN|UPDATE|SEND|ASSIGN|PAYMENT)$|^ROLE_|^USER_/.test(p))).toEqual([]);
  });

  test("D5: MO holds no role / user / tenant administration, admin, api, lookup-write or test codes", () => {
    expect(byCode.MO.permissions.filter((p) => /^(ROLE_|ADMIN_|API_|TENANT_(WRITE|DELETE|ADMIN)|USER_(WRITE|DELETE|CODE)|LOOKUP(TYPE)?_(WRITE|DELETE))/.test(p))).toEqual([]);
  });

  test("D1 / D8: no non-catalogue legacy code and no test-like code anywhere", () => {
    const all = manifest.roles.flatMap((r) => r.permissions);
    for (const c of ["ACCOUNT_PAYMENT", "ACCOUNT_READ", "ACCOUNT_TRANSACTION_READ", "READ_ONLY", "NEW_PERM1", "NEW_PERM3", "ONLY FOR DELETE", "TEST_READ"]) expect(all).not.toContain(c);
    expect(all.filter((p) => /^(TEST|NEW_PERM)|FSDF|DFSDF/.test(p))).toEqual([]);
  });

  test("schema-complete: every role has non-placeholder name + description and a 1-100 level", () => {
    expect(manifestProblems(manifest)).toEqual([]);
    for (const r of manifest.roles) expect(r.description.length).toBeGreaterThan(3);
  });
});

describe("validator refuses", () => {
  test.each([
    ["the retired SU code", (m) => m.roles.push({ ...m.roles.find((r) => r.code === "REO"), code: "SU", name: "Super User" })],
    ["SU in another case", (m) => { m.roles.find((r) => r.code === "REO").code = "su"; }],
    ["a platform permission", (m) => { m.roles[1].permissions = ["PLATFORM_TENANT_READ"]; }],
    ["a wildcard", (m) => { m.roles[1].permissions = ["*"]; }],
    ["an ObjectId entry", (m) => { m.roles[1].permissions = ["68cbf7806080b4621d469d34"]; }],
    ["a canonical resource:action form", (m) => { m.roles[1].permissions = ["tenant:read"]; }],
    ["unsorted permissions", (m) => { m.roles[1].permissions = ["ZZZ_READ", "AAA_READ"]; }],
    ["duplicate permissions", (m) => { m.roles[1].permissions = ["AAA_READ", "AAA_READ"]; }],
    ["a second tenant admin", (m) => { m.roles.find((r) => r.code === "MO").tenantAdmin = true; }],
    ["no tenant admin", (m) => { m.roles.find((r) => r.code === "ASU").tenantAdmin = false; }],
    ["ASU not SYSTEM", (m) => { m.roles.find((r) => r.code === "ASU").category = "CRM"; }],
    ["a non-ASU SYSTEM role", (m) => { m.roles.find((r) => r.code === "MO").category = "SYSTEM"; }],
    ["a duplicate code", (m) => m.roles.push({ ...m.roles.find((r) => r.code === "MO"), name: "Other" })],
    ["a duplicate name", (m) => { m.roles.find((r) => r.code === "MO").name = m.roles.find((r) => r.code === "REO").name; }],
    ["placeholder description", (m) => { m.roles[1].description = "TODO"; }],
    ["an extra role key", (m) => { m.roles[1].isActive = true; }],
    ["a missing role key", (m) => { delete m.roles[1].level; }],
    ["a level out of range", (m) => { m.roles[1].level = 101; }],
    ["an extra top-level key", (m) => { m.extra = 1; }],
    ["a wrong kind", (m) => { m.kind = "account-service:grid-system-defaults"; }],
  ])("%s", (_n, mutate) => {
    const m = clone();
    mutate(m);
    expect(manifestProblems(m).length).toBeGreaterThan(0);
    expect(() => validateManifest(m)).toThrow(expect.objectContaining({ code: "TENANT_ROLE_MANIFEST_INVALID" }));
  });
});

describe("source guards (retired SU never returns through P5 code)", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  test("the provisioning + manifest code carries no SU literal and never clones from another tenant", () => {
    for (const f of ["services/tenantRoleProvisioning.js", "services/tenantRoleManifest.js", "services/tenantRoleCache.js"]) {
      const s = read(f);
      expect({ f, su: /["'`]SU["'`]|\bSU\s*:/.test(s) }).toEqual({ f, su: false });
      expect({ f, main: /["'`]MAIN["'`]/.test(s) }).toEqual({ f, main: false });
    }
  });
  test("the only SU literal is the refusal list in constants/retiredRoleCodes.js", () => {
    const s = read("constants/retiredRoleCodes.js");
    expect(s.match(/["'`]SU["'`]/g)).toHaveLength(1);
    expect(s).toMatch(/RETIRED_TENANT_ROLE_CODES = Object\.freeze\(\["SU"\]\)/);
  });
  test("ensureTenantRoles is not wired into any route, tenant creation or template yet", () => {
    const walk = (dir) => fs.readdirSync(path.join(__dirname, "..", dir)).filter((f) => f.endsWith(".js")).map((f) => `${dir}/${f}`);
    const callers = [...walk("routes"), ...walk("controllers"), ...walk("handlers"), "constants/provisioningComponents.js", "constants/platformTemplates.js", "bin/user-service.js", "app.js"]
      .filter((f) => /tenantRoleProvisioning|ensureTenantRoles|tenantRoles\.v1/.test(read(f)));
    expect(callers).toEqual([]);
  });
});

