/**
 * PDP rollout P4 - the proposed audience map (constants/permissionAudience.js) against the DEV catalogue
 * snapshot (tests/fixtures/p4-dev-audience-snapshot.json, read-only export, no user data).
 */
const {
  AUDIENCES,
  PROPOSED_AUDIENCE,
  audienceClassOf,
  audienceAdmits,
} = require("../constants/permissionAudience");
const { isPlatformNamespace } = require("../constants/permissionClassification");
const SNAPSHOT = require("./fixtures/p4-dev-audience-snapshot.json");

const byCode = new Map(SNAPSHOT.catalogue.map((p) => [p.code, p]));

describe("map integrity against the DEV catalogue snapshot", () => {
  test("every mapped code is an ACTIVE catalogue row with a valid audience", () => {
    for (const [code, audience] of Object.entries(PROPOSED_AUDIENCE)) {
      expect(AUDIENCES).toContain(audience);
      const row = byCode.get(code);
      expect({ code, present: !!row, active: row && row.isActive }).toEqual({ code, present: true, active: true });
    }
  });

  test("every stored audience (the 9 P1 rows) equals the map - stored wins, so they must agree", () => {
    const stored = SNAPSHOT.catalogue.filter((p) => p.audience);
    expect(stored).toHaveLength(9);
    for (const p of stored) expect([p.code, PROPOSED_AUDIENCE[p.code]]).toEqual([p.code, p.audience]);
  });

  test("no mapped code is in the platform namespace", () => {
    for (const code of Object.keys(PROPOSED_AUDIENCE)) {
      const p = byCode.get(code);
      expect(isPlatformNamespace(`${p.resource}:${p.action}`)).toBe(false);
    }
  });

  test("rows sharing one resource:action never get different audiences (accounts.reports:read has two codes)", () => {
    const seen = new Map();
    for (const [code, audience] of Object.entries(PROPOSED_AUDIENCE)) {
      const p = byCode.get(code);
      const key = `${p.resource}:${p.action}`.toLowerCase();
      if (seen.has(key)) expect([key, audience]).toEqual([key, seen.get(key)]);
      else seen.set(key, audience);
    }
  });

  test("proposal §2b classes: portal-only codes, BOTH codes, and legacy (unmapped) codes", () => {
    expect(Object.keys(PROPOSED_AUDIENCE).filter((c) => PROPOSED_AUDIENCE[c] === "PORTAL").sort()).toEqual(
      ["PORTAL_CREATE", "PORTAL_DELETE", "PORTAL_READ", "PORTAL_WRITE", "REGISTRATIONS_CREATE", "REGISTRATIONS_READ", "REGISTRATIONS_WRITE"],
    );
    expect(Object.keys(PROPOSED_AUDIENCE).filter((c) => PROPOSED_AUDIENCE[c] === "BOTH").sort()).toEqual(
      ["ACCOUNTS.MEMBER_READ", "COMMUNICATION_READ", "EVENTS_READ", "LOOKUPTYPE_READ", "LOOKUP_READ", "PRODUCT_READ"],
    );
    for (const legacy of ["MENU_FINANCE_ACCESS", "CRM_ACCESS", "NOTIFICATION_READ", "DASHBOARD_READ", "USER_READ", "ROLE_READ", "TENANT_WRITE", "PAYMENTS_CREATE", "QUERIES_READ"]) {
      expect([legacy, PROPOSED_AUDIENCE[legacy]]).toEqual([legacy, undefined]);
    }
  });
});

describe("caller class", () => {
  test.each([
    ["CRM", "CRM"], ["crm", "CRM"], ["PORTAL", "PORTAL"], ["MEMBER", "PORTAL"],
    ["SYSTEM", null], ["", null], [undefined, null], [null, null], ["ADMIN", null],
  ])("userType %p -> %p", (t, cls) => expect(audienceClassOf(t)).toBe(cls));

  test.each([
    ["CRM", "CRM", true], ["CRM", "PORTAL", false], ["PORTAL", "PORTAL", true], ["PORTAL", "CRM", false],
    ["BOTH", "CRM", true], ["BOTH", "PORTAL", true], ["BOTH", null, false], ["CRM", null, false],
  ])("audience %s admits %p: %p", (a, cls, ok) => expect(audienceAdmits(a, cls)).toBe(ok));
});
