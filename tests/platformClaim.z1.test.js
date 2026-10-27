/**
 * Phase B / Z1 - PlatformPrincipal store + `plat` claim (shadow).
 *
 *  - PLATFORM_AUTH_MODE: unset / unknown = off (no lookup, no claim); shadow and enforce issue.
 *  - The claim is issued only for an ACTIVE PlatformPrincipal matching the VERIFIED (issuer, oid),
 *    with tid agreeing and the user bound to that oid. Email, roles (SU, "*"), tenant: irrelevant.
 *  - Claim contract { v: 1, pid, rev } - nothing else; never on the fallback token.
 *  - Request body / query / headers can never produce a claim.
 *  - The model rejects non-catalogue permissions, unknown fields, a tid that is not the issuer's
 *    directory, and any change to the identity fields.
 */
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const OTHER_DIR = "11111111-2222-3333-4444-555555555555";
const ISSUER = `https://login.microsoftonline.com/${DIR}/v2.0`;
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const PID = "6a0000000000000000000a01";
const TENANT_A = "68cbf7806080b4621d469d34";

const jwt = require("jsonwebtoken");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const { PLATFORM_PERMISSIONS, isPlatformPermission } = require("../constants/platformPermissions");
const { resolvePlatformClaim, platformAuthMode } = require("../services/platformClaimService");

const identity = (o = {}) => ({ issuer: ISSUER, oid: OID, tid: DIR, amr: null, ...o });
const crmUser = (o = {}) => ({
  _id: "u1", tenantId: TENANT_A, userEmail: "platform@example.org", userType: "CRM", userMicrosoftId: OID, ...o,
});
const principal = (o = {}) => ({ _id: PID, tid: DIR, status: "active", revision: 3, permissions: ["platform:tenant:read:any"], ...o });

function mockLookup(result) {
  const lean = typeof result === "function" ? jest.fn(result) : jest.fn().mockResolvedValue(result);
  const select = jest.fn(() => ({ lean }));
  const spy = jest.spyOn(PlatformPrincipal, "findOne").mockImplementation(() => ({ select }));
  return { spy, select, lean };
}

let logs;
beforeEach(() => {
  logs = [];
  jest.spyOn(console, "info").mockImplementation((...a) => logs.push(a.join(" ")));
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.PLATFORM_AUTH_MODE;
});

describe("PLATFORM_AUTH_MODE", () => {
  test.each([[undefined, "off"], ["", "off"], ["off", "off"], ["shadow", "shadow"], ["enforce", "enforce"], ["SHADOW", "off"], ["on", "off"], ["true", "off"]])(
    "%p -> %p", (raw, want) => {
      if (raw === undefined) delete process.env.PLATFORM_AUTH_MODE; else process.env.PLATFORM_AUTH_MODE = raw;
      expect(platformAuthMode()).toBe(want);
    });

  test("off: no lookup, no claim, no decision log", async () => {
    const { spy } = mockLookup(principal());
    const out = await resolvePlatformClaim({ verifiedIdentity: identity(), user: crmUser() });
    expect(out).toEqual({ claim: null, decision: "mode_off", mode: "off" });
    expect(spy).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
  });
});

describe.each(["shadow", "enforce"])("resolvePlatformClaim (%s)", (mode) => {
  beforeEach(() => { process.env.PLATFORM_AUTH_MODE = mode; });

  test("active principal for the verified (issuer, oid) -> claim { v, pid, rev } only", async () => {
    const { spy, select } = mockLookup(principal());
    const out = await resolvePlatformClaim({ verifiedIdentity: identity(), user: crmUser() });
    expect(out.decision).toBe("issued");
    expect(out.claim).toEqual({ v: 1, pid: PID, rev: 3 });
    // Keyed ONLY by the verified identity: no email, tenant, role or name in the query.
    expect(spy).toHaveBeenCalledWith({ issuer: ISSUER, oid: OID });
    expect(select).toHaveBeenCalledWith({ _id: 1, tid: 1, status: 1, revision: 1, permissions: 1 });
  });

  test("existing users (no principal) get no claim - even a legacy SU with '*'", async () => {
    mockLookup(null);
    const su = crmUser({ roles: [{ code: "SU" }], permissions: ["*"] });
    const out = await resolvePlatformClaim({ verifiedIdentity: identity(), user: su });
    expect(out).toMatchObject({ claim: null, decision: "not_principal" });
  });

  test("disabled principal -> no claim", async () => {
    mockLookup(principal({ status: "disabled" }));
    expect(await resolvePlatformClaim({ verifiedIdentity: identity(), user: crmUser() })).toMatchObject({ claim: null, decision: "disabled" });
  });

  test("principal of another directory (tid mismatch) -> no claim", async () => {
    mockLookup(principal({ tid: OTHER_DIR }));
    expect(await resolvePlatformClaim({ verifiedIdentity: identity(), user: crmUser() })).toMatchObject({ claim: null, decision: "identity_mismatch" });
  });

  test("identity binding: the signed-in user must be bound to the verified oid (not matched by email)", async () => {
    const { spy } = mockLookup(principal());
    const out = await resolvePlatformClaim({ verifiedIdentity: identity(), user: crmUser({ userMicrosoftId: "ffff0000-0000-0000-0000-000000000000" }) });
    expect(out).toMatchObject({ claim: null, decision: "binding_mismatch" });
    expect(spy).not.toHaveBeenCalled();
  });

  test.each([
    ["missing identity", undefined],
    ["no oid (sub only)", identity({ oid: null })],
    ["non-GUID oid", identity({ oid: "platform@example.org" })],
    ["non-Entra issuer", identity({ issuer: "https://evil.example/v2.0" })],
    ["tid not the issuer's directory", identity({ tid: OTHER_DIR })],
  ])("%s -> no lookup, no claim", async (_n, verifiedIdentity) => {
    const { spy } = mockLookup(principal());
    const out = await resolvePlatformClaim({ verifiedIdentity, user: crmUser() });
    expect(out).toMatchObject({ claim: null, decision: "no_verified_identity" });
    expect(spy).not.toHaveBeenCalled();
  });

  test("lookup failure -> no claim (fail closed), sign-in not failed", async () => {
    mockLookup(() => Promise.reject(Object.assign(new Error("connection refused mongodb://u:p@h"), { name: "MongoNetworkError" })));
    const out = await resolvePlatformClaim({ verifiedIdentity: identity(), user: crmUser() });
    expect(out).toMatchObject({ claim: null, decision: "lookup_error" });
    expect(logs.join("\n")).not.toContain("mongodb://");
  });

  test("decision log: one structured line, no oid / email / full principal id", async () => {
    mockLookup(principal());
    await resolvePlatformClaim({ verifiedIdentity: identity(), user: crmUser() });
    expect(logs).toHaveLength(1);
    const line = logs[0];
    expect(line).toContain("[platform-auth]");
    const rec = JSON.parse(line.slice(line.indexOf("{")));
    expect(rec).toMatchObject({ event: "platform.claim.decision", mode, decision: "issued", claimIssued: true, userId: "u1", tenantId: TENANT_A, principalId: "…000a01", mfa: "unknown" });
    for (const s of [OID, "platform@example.org", PID, ISSUER]) expect(line).not.toContain(s);
  });
});

describe("platform permission catalogue", () => {
  test("namespaced platform:*, frozen, '*' is not one of them", () => {
    expect(Object.isFrozen(PLATFORM_PERMISSIONS)).toBe(true);
    expect(PLATFORM_PERMISSIONS.every((p) => p.startsWith("platform:"))).toBe(true);
    expect(isPlatformPermission("*")).toBe(false);
    expect(isPlatformPermission("tenant:create")).toBe(false);
    expect(isPlatformPermission("platform:tenant:create")).toBe(true);
  });
});

describe("PlatformPrincipal model", () => {
  const valid = (o = {}) => ({ issuer: ISSUER, oid: OID, tid: DIR, permissions: ["platform:cache:admin"], createdBy: "ops", updatedBy: "ops", ...o });

  test("valid record validates; unique index on (issuer, oid)", async () => {
    await expect(new PlatformPrincipal(valid()).validate()).resolves.toBeUndefined();
    const idx = PlatformPrincipal.schema.indexes().find(([key]) => JSON.stringify(key) === JSON.stringify({ issuer: 1, oid: 1 }));
    expect(idx[1]).toMatchObject({ unique: true, name: "uniq_platform_identity" });
  });

  test.each([
    ["tenant permission", { permissions: ["tenant:create"] }],
    ["wildcard", { permissions: ["*"] }],
    ["duplicate", { permissions: ["platform:cache:admin", "platform:cache:admin"] }],
    ["bad status", { status: "superuser" }],
    ["non-GUID oid", { oid: "someone@example.org" }],
    ["non-Entra issuer", { issuer: "https://example.org/v2.0" }],
    ["tid not the issuer's directory", { tid: OTHER_DIR }],
  ])("rejects %s", async (_n, o) => {
    await expect(new PlatformPrincipal(valid(o)).validate()).rejects.toThrow();
  });

  test("unknown fields (email, token, ...) are rejected", () => {
    expect(() => new PlatformPrincipal(valid({ email: "x@example.org" }))).toThrow();
  });

  test.each([
    [{ $set: { oid: "bbbb1111-bbbb-2222-cccc-3333dddd4444" } }],
    [{ $set: { issuer: `https://login.microsoftonline.com/${OTHER_DIR}/v2.0` } }],
    [{ $unset: { tid: 1 } }],
    [{ oid: "bbbb1111-bbbb-2222-cccc-3333dddd4444" }],
  ])("identity fields cannot be changed by a query update %#", async (update) => {
    await expect(PlatformPrincipal.updateOne({ _id: PID }, update).exec()).rejects.toThrow(/immutable/);
  });
});

describe("generateToken plat claim", () => {
  const RoleHandler = require("../handlers/role.handler");
  const jwtHelper = require("../helpers/jwt");
  const SECRET = "unit-test-only-secret";
  let saved;
  beforeEach(() => { saved = [process.env.JWT_SECRET, process.env.JWT_EXPIRY]; process.env.JWT_SECRET = SECRET; process.env.JWT_EXPIRY = "1h"; });
  afterEach(() => { [process.env.JWT_SECRET, process.env.JWT_EXPIRY] = saved; });

  test("with a claim: plat = { v, pid, rev } only; tenant claims unchanged", async () => {
    jest.spyOn(RoleHandler, "getUserPermissions").mockResolvedValue(["*"]);
    jest.spyOn(RoleHandler, "getUserRoles").mockResolvedValue([{ _id: "r1", code: "SU", name: "Super User" }]);
    const plain = jwt.verify((await jwtHelper.generateToken(crmUser())).token, SECRET);
    const withClaim = jwt.verify((await jwtHelper.generateToken(crmUser(), { platformClaim: { v: 1, pid: PID, rev: 3, permissions: ["x"], email: "e" } })).token, SECRET);
    expect(plain).not.toHaveProperty("plat");
    expect(withClaim.plat).toEqual({ v: 1, pid: PID, rev: 3 });
    for (const k of ["sub", "tenantId", "id", "email", "userType", "roles", "permissions"]) expect(withClaim[k]).toEqual(plain[k]);
  });

  test("fallback token never carries plat", async () => {
    jest.spyOn(RoleHandler, "getUserPermissions").mockRejectedValue(new Error("db down"));
    const t = jwt.verify((await jwtHelper.generateToken(crmUser(), { platformClaim: { v: 1, pid: PID, rev: 1 } })).token, SECRET);
    expect(t).not.toHaveProperty("plat");
    expect(t.permissions).toEqual([]);
  });
});

describe("verified identity from the Microsoft ID token (AzureADHandler.decodeIdToken)", () => {
  const AzureADHandler = require("../handlers/azure.ad.handler");
  const { resolveConnectionAuthConfig } = require("../helpers/connectionAuthConfig");
  const { makeTestKeypairAndJwks, signTestJwt } = require("./helpers/testJwt");
  const CLIENT = "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae"; // = tests/setupEntraEnv.js
  let privateKey;
  beforeAll(async () => { const kp = await makeTestKeypairAndJwks(); privateKey = kp.privateKey; AzureADHandler._resetJwksForTests(kp.jwks); });
  afterAll(() => AzureADHandler._resetJwksForTests(null));
  const decode = async (claims) => AzureADHandler.decodeIdToken(
    await signTestJwt(privateKey, { iss: ISSUER, aud: CLIENT, tid: DIR, nonce: "n", ...claims }), "n",
    resolveConnectionAuthConfig(null, { connectionType: "Entra ID (Azure AD)" }));

  test("verifiedIdentity = verified iss / oid / tid; non-enumerable (never spread into the user record)", async () => {
    const p = await decode({ oid: OID, sub: "sub-1", email: "a@example.org", amr: ["pwd", "mfa"] });
    expect(p.verifiedIdentity).toEqual({ issuer: ISSUER, oid: OID, tid: DIR, amr: ["pwd", "mfa"] });
    expect(Object.keys(p)).not.toContain("verifiedIdentity");
    expect({ ...p }).not.toHaveProperty("verifiedIdentity");
  });

  test("oid strictly: a token without oid gives oid null (no sub fallback) -> no claim", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    const p = await decode({ sub: "sub-only" });
    expect(p.verifiedIdentity.oid).toBeNull();
    const { spy } = mockLookup(principal());
    const out = await resolvePlatformClaim({ verifiedIdentity: p.verifiedIdentity, user: crmUser({ userMicrosoftId: "sub-only" }) });
    expect(out.decision).toBe("no_verified_identity");
    expect(spy).not.toHaveBeenCalled();
  });
});
