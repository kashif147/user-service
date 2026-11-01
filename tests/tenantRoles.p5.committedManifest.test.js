/**
 * P5 - the committed CANONICAL tenant-roles manifest (config/tenantRoles.v1.json). PROVISIONAL and HELD: the content
 * (and so its sha256) changes until the portal authorization remediation and the owner's content decisions close.
 * Pure: no database. The validator itself is tests/tenantRoles.p5.manifest.test.js.
 */
const fs = require("fs");
const crypto = require("crypto");
const { loadManifest, manifestProblems, MANIFEST_PATH } = require("../services/tenantRoleManifest");
const DEV = require("./fixtures/p5-dev-permission-catalogue.json");

const raw = fs.readFileSync(MANIFEST_PATH);
const { manifest, sha256, version } = loadManifest();
const byCode = Object.fromEntries(manifest.roles.map((r) => [r.code, r]));

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


describe("2026-11-01 owner content decisions", () => {
  test("ASU canonical description (no environment wording)", () => {
    expect(byCode.ASU.description).toBe("Assistant Super User: highest administrator of its own tenant");
    expect(manifest.roles.filter((r) => /staging|\bdev\b|\buat\b|\bprod\b/i.test(`${r.name} ${r.description}`)).map((r) => r.code)).toEqual([]);
  });
  test("REO approved additions present (TENANT_READ conditional on the PDP category fix); REO mutation-free", () => {
    expect(byCode.REO.permissions).toEqual(expect.arrayContaining(["PRODUCT_READ", "APPLICATION_READ", "CRM_MEMBER_READ", "CRM_ACCESS", "TENANT_READ"]));
    expect(byCode.REO.permissions.filter((p) => !/_(READ|ACCESS)$/.test(p))).toEqual([]);
  });
  test("MO: approved reads present; ISSUES_WRITE NOT approved; PAYMENTS_WRITE stays removed; USER_READ provisional", () => {
    expect(byCode.MO.permissions).toEqual(expect.arrayContaining(["ISSUES_READ", "PRODUCT_READ", "PRODUCT_TYPE_READ", "PRICING_READ", "USER_READ"]));
    expect(byCode.MO.permissions).not.toContain("ISSUES_WRITE");
    expect(byCode.MO.permissions).not.toContain("PAYMENTS_WRITE");
  });
  test("every code is an ACTIVE DEV catalogue code; no inactive, test-like or duplicate/dead code", () => {
    const cat = new Map(DEV.catalogue.map((c) => [c.code, c]));
    const all = [...new Set(manifest.roles.flatMap((r) => r.permissions))];
    expect(all.filter((p) => !cat.has(p))).toEqual([]);
    expect(all.filter((p) => cat.get(p).isActive === false)).toEqual([]);
    for (const c of ["ACCOUNTS_REPORTS", "USER_CODE", "ADMIN_ACCESS0057", "NEW_PERM1", "NEW_PERM3", "ONLY FOR DELETE", "TEST_READ"]) expect(all).not.toContain(c);
  });
});
