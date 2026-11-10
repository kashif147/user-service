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


const P8_DRAFT = {
  MO: ["ACCOUNTS.MEMBER_READ", "APPLICATION_CREATE", "APPLICATION_PAYMENT_LINKS_READ", "APPLICATION_PAYMENT_LINKS_WRITE", "APPLICATION_READ", "APPLICATION_WRITE", "AUDIT_READ", "CHANGEOFCATEGORY_READ", "COMMUNICATION_CREATE", "COMMUNICATION_DELETE", "COMMUNICATION_READ", "COMMUNICATION_WRITE", "CONTACT_READ", "CORN_MARKET_NEW_GRADUATE_READ", "CORN_MARKET_REWARDS_READ", "DASHBOARD_READ", "DIRECTORY_READ", "EVENTS_CREATE", "EVENTS_READ", "EVENTS_WRITE", "ISSUES_COMPLAINTS_READ", "ISSUES_COMPLAINTS_WRITE", "ISSUES_READ", "ISSUES_TEMPLATES_READ", "ISSUES_WRITE", "LOOKUPTYPE_READ", "LOOKUP_READ", "MENU_CONFIGURATION_ACCESS", "MENU_CORRESPONDENCE_ACCESS", "MENU_EVENTS_ACCESS", "MENU_FINANCE_ACCESS", "MENU_MEMBERSHIP_ACCESS", "MENU_REPORTS_ACCESS", "NOTIFICATION_CREATE", "NOTIFICATION_READ", "PAYMENTS_READ", "PRICING_READ", "PRODUCT_READ", "PRODUCT_TYPE_READ", "PROFILE_CREATE", "PROFILE_READ", "PROFILE_WRITE", "RECRUIT_FRIEND_READ", "REPORTING.LISTINGS_READ", "REPORTING.STATISTICS_READ", "REPORTING.TEMPLATES_READ", "REPORTING.TEMPLATES_WRITE", "SUBSCRIPTIONS_READ", "SUBSCRIPTIONS_WRITE", "TEMPLATE_READ", "TENANT_READ", "TRANSFERREQUESTS_READ", "TRANSFERREQUESTS_WRITE"],
  REO: ["APPLICATION_PAYMENT_LINKS_READ", "APPLICATION_READ", "CHANGEOFCATEGORY_READ", "EVENTS_READ", "ISSUES_READ", "ISSUES_TEMPLATES_READ", "LOOKUPTYPE_READ", "LOOKUP_READ", "MENU_FINANCE_ACCESS", "MENU_MEMBERSHIP_ACCESS", "MENU_REPORTS_ACCESS", "NOTIFICATION_READ", "PAYMENTS_READ", "PRICING_READ", "PRODUCT_READ", "PRODUCT_TYPE_READ", "PROFILE_READ", "REPORTING.LISTINGS_READ", "REPORTING.STATISTICS_READ", "REPORTING.TEMPLATES_READ", "SUBSCRIPTIONS_READ", "TENANT_READ", "TRANSFERREQUESTS_READ"],
  MEMBER: ["ACCOUNTS.MEMBER_READ", "EVENTS_READ", "LOOKUP_READ", "PORTAL_CREATE", "PORTAL_READ", "PORTAL_WRITE", "PRODUCT_READ", "REGISTRATIONS_CREATE", "REGISTRATIONS_READ", "REGISTRATIONS_WRITE"],
};
P8_DRAFT["NON-MEMBER"] = P8_DRAFT.MEMBER;

describe("P8 draft target sets (2026-11-10, PROVISIONAL - hash not frozen)", () => {
  test.each(Object.keys(P8_DRAFT))("%s is exactly the P8 draft set", (code) => {
    expect(byCode[code].permissions).toEqual(P8_DRAFT[code]);
  });
  test("counts: MO 53, REO 23 (draft target), MEMBER 10, NON-MEMBER 10", () => {
    expect(Object.fromEntries(Object.keys(P8_DRAFT).map((c) => [c, byCode[c].permissions.length]))).toEqual({ MO: 53, REO: 23, MEMBER: 10, "NON-MEMBER": 10 });
  });
  test("REO 23: the two retained issue reads are base-only - no team code, so no case of any type is visible", () => {
    expect(byCode.REO.permissions.filter((p) => p.startsWith("ISSUES_"))).toEqual(["ISSUES_READ", "ISSUES_TEMPLATES_READ"]);
  });
  test("duplicate merge stays ASU-only: no role but ASU-by-wildcard can merge (no PROFILE_DELETE / PROFILE.MERGE_WRITE on MO)", () => {
    for (const p of ["PROFILE_DELETE", "PROFILE.MERGE_WRITE"]) expect(byCode.MO.permissions).not.toContain(p);
    expect(manifest.roles.flatMap((r) => r.permissions)).not.toContain("PROFILE.MERGE_WRITE");
  });
  test("portal roles carry only PORTAL / BOTH audience codes (no CRM-audience code)", () => {
    expect(P8_DRAFT.MEMBER.filter((p) => /^(PROFILE|PAYMENTS|APPLICATION|ACCOUNTS\.REPORTS)_?/.test(p))).toEqual([]);
  });
  test("the other 20 roles are unchanged from #39 b33fc00 (P8 changes only MO / REO / MEMBER / NON-MEMBER)", () => {
    const { execFileSync } = require("child_process");
    const base = JSON.parse(execFileSync("git", ["show", "b33fc00:config/tenantRoles.v1.json"], { cwd: require("path").join(__dirname, "..") }).toString());
    const others = (m) => m.roles.filter((r) => !(r.code in P8_DRAFT)).map((r) => JSON.stringify(r)).sort();
    expect(others(manifest)).toEqual(others(base));
  });
});

describe("2026-11-01 owner content decisions", () => {
  test("ASU canonical description (no environment wording)", () => {
    expect(byCode.ASU.description).toBe("Assistant Super User: highest administrator of its own tenant");
    expect(manifest.roles.filter((r) => /staging|\bdev\b|\buat\b|\bprod\b/i.test(`${r.name} ${r.description}`)).map((r) => r.code)).toEqual([]);
  });
  test("REO approved additions present (TENANT_READ conditional on the PDP category fix); REO mutation-free", () => {
    // P8 draft (2026-11-10): the legacy CRM_MEMBER_READ / CRM_ACCESS codes leave REO (no backend consumer; CRM UI gap noted).
    expect(byCode.REO.permissions).toEqual(expect.arrayContaining(["PRODUCT_READ", "APPLICATION_READ", "TENANT_READ"]));
    expect(byCode.REO.permissions.filter((p) => !/_(READ|ACCESS)$/.test(p))).toEqual([]);
  });
  test("MO: approved reads present; PAYMENTS_WRITE stays removed; USER_READ removed, DIRECTORY_READ added (2026-11-02)", () => {
    expect(byCode.MO.permissions).toEqual(expect.arrayContaining(["ISSUES_READ", "PRODUCT_READ", "PRODUCT_TYPE_READ", "PRICING_READ", "DIRECTORY_READ"]));
    expect(byCode.MO.permissions).not.toContain("USER_READ");
    expect(byCode.MO.permissions).not.toContain("PAYMENTS_WRITE");
  });
  test("MO ISSUES_WRITE (2026-11-04 Q1, supersedes the 2026-11-01 withholding): complaints-only - the only team codes are COMPLAINTS", () => {
    // issue-service enforces the team: every case route needs the base issues:read/write AND, per case type, the team
    // issues-<team>:read (visibility) / issues-<team>:write (create, update, status, delete, activities, attachments).
    expect(byCode.MO.permissions).toEqual(expect.arrayContaining(["ISSUES_READ", "ISSUES_WRITE", "ISSUES_TEMPLATES_READ", "ISSUES_COMPLAINTS_READ", "ISSUES_COMPLAINTS_WRITE"]));
    expect(byCode.MO.permissions.filter((p) => /^ISSUES_(FTP|IR|DATAPROTECTION)_/.test(p))).toEqual([]);
  });
  test("portal roles: none of the 23 reviewed family codes (QUERIES / VOTING / RESOURCES / TRANSFERREQUESTS / CHANGEOFCATEGORY / SUBSCRIPTIONS); MEMBER 24, NON-MEMBER 22", () => {
    for (const r of ["MEMBER", "NON-MEMBER"]) {
      expect(byCode[r].permissions.filter((p) => /^(QUERIES|VOTING|RESOURCES|TRANSFERREQUESTS|CHANGEOFCATEGORY|SUBSCRIPTIONS)_/.test(p))).toEqual([]);
    }
    expect(byCode.MEMBER.permissions).toHaveLength(10); // P8 draft 2026-11-10 (was 24 / 22 at b33fc00)
    expect(byCode["NON-MEMBER"].permissions).toHaveLength(10);
  });
  test("portal roles (2026-11-08): no staff events / communication codes; EVENTS_READ kept; REGISTRATIONS_* on both", () => {
    for (const r of ["MEMBER", "NON-MEMBER"]) {
      const perms = byCode[r].permissions;
      expect(perms.filter((p) => /^EVENTS_(CREATE|WRITE|DELETE)$|^COMMUNICATION_/.test(p))).toEqual([]);
      expect(perms).toEqual(expect.arrayContaining(["EVENTS_READ", "REGISTRATIONS_CREATE", "REGISTRATIONS_READ", "REGISTRATIONS_WRITE"]));
    }
  });
  test("every code is an ACTIVE DEV catalogue code; no inactive, test-like or duplicate/dead code", () => {
    const cat = new Map(DEV.catalogue.map((c) => [c.code, c]));
    const all = [...new Set(manifest.roles.flatMap((r) => r.permissions))];
    expect(all.filter((p) => !cat.has(p))).toEqual([]);
    expect(all.filter((p) => cat.get(p).isActive === false)).toEqual([]);
    for (const c of ["ACCOUNTS_REPORTS", "USER_CODE", "ADMIN_ACCESS0057", "NEW_PERM1", "NEW_PERM3", "ONLY FOR DELETE", "TEST_READ"]) expect(all).not.toContain(c);
  });
});
