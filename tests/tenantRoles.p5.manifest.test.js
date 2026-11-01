/**
 * P5 - the tenant-roles manifest validator and loader (services/tenantRoleManifest.js), against INLINE fixtures only.
 * Pure: no database. The canonical content (config/tenantRoles.v1.json) is NOT part of the foundation; its own tests
 * ship with it. The DB behaviour is tests/tenantRoles.p5.db.test.js.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { loadManifest, manifestProblems, validateManifest } = require("../services/tenantRoleManifest");

const FIXTURE = {
  kind: "user-service:tenant-roles",
  version: 1,
  source: "validator test fixture",
  invariants: { insertMissingOnly: true },
  roles: [
    { code: "ASU", name: "Assistant Super User", description: "Highest administrator of its own tenant", category: "SYSTEM", level: 95, isSystemRole: true, tenantAdmin: true, permissions: ["TENANT_ADMIN", "TENANT_READ"] },
    { code: "REO", name: "Read Only", description: "Read-only staff access", category: "CRM", level: 10, isSystemRole: false, tenantAdmin: false, permissions: ["PROFILE_READ", "TENANT_READ"] },
    { code: "MO", name: "Membership Officer", description: "Membership Officer", category: "CRM", level: 60, isSystemRole: false, tenantAdmin: false, permissions: ["PROFILE_READ", "PROFILE_WRITE"] },
    { code: "MEMBER", name: "Member", description: "Registered member", category: "PORTAL", level: 1, isSystemRole: false, tenantAdmin: false, permissions: ["PROFILE_READ"] },
  ],
};
const clone = () => JSON.parse(JSON.stringify(FIXTURE));
const tmp = (name, bytes) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p5-manifest-")), name);
  fs.writeFileSync(f, bytes);
  return f;
};

describe("validator accepts + loader identity", () => {
  test("a well-formed manifest has no problems", () => {
    expect(manifestProblems(clone())).toEqual([]);
    expect(() => validateManifest(clone())).not.toThrow();
  });
  test("identity = version + sha256 of the RAW bytes (formatting changes the hash)", () => {
    const pretty = `${JSON.stringify(FIXTURE, null, 2)}\n`;
    const a = loadManifest(tmp("a.json", pretty));
    const b = loadManifest(tmp("b.json", JSON.stringify(FIXTURE)));
    expect(a.version).toBe(1);
    expect(a.sha256).toBe(crypto.createHash("sha256").update(pretty).digest("hex"));
    expect(b.sha256).not.toBe(a.sha256);
  });
  test("invalid JSON -> TENANT_ROLE_MANIFEST_INVALID", () => {
    expect(() => loadManifest(tmp("bad.json", "{ not json"))).toThrow(expect.objectContaining({ code: "TENANT_ROLE_MANIFEST_INVALID" }));
  });
  test("a missing file surfaces ENOENT (ensureTenantRoles maps it to MANIFEST_NOT_FOUND)", () => {
    expect(() => loadManifest(path.join(os.tmpdir(), `p5-absent-${Date.now()}`, "tenantRoles.v1.json"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
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

