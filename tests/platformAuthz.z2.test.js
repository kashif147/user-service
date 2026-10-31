/**
 * Phase B / Z2 - platform authorization evaluator, middleware and DEV probe.
 *
 * Real evaluator (services/platformAuthorizationService.js), real middleware, real probe router and the
 * real HS256 verifier (middlewares/auth.verifyProjectShellToken) with a test-only secret. The
 * PlatformPrincipal / User reads are stubbed in memory; authenticate is a stub that sets the trusted
 * req.ctx from x-test-* headers (standing in for the gateway-verified identity). No DB / network.
 */
process.env.PLATFORM_AUTHZ_PROBE = "on";
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: () => false,
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1,
  hasMinimumRole: () => false,
}));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    authenticate: (req, res, next) => {
      const t = req.headers["x-test-tenant"];
      if (t) req.ctx = { tenantId: t, userId: req.headers["x-test-user"], roles: JSON.parse(req.headers["x-test-roles"] || "[]"), permissions: JSON.parse(req.headers["x-test-perms"] || "[]") };
      next();
    },
    tenantContextWarn: (req, res, next) => next(),
  };
});

const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");
const { PLATFORM_PERMISSIONS, isPlatformPermission } = require("../constants/platformPermissions");
const { evaluatePlatformPermission, REASONS } = require("../services/platformAuthorizationService");
const { requirePlatformPermission, observePlatformPermission } = require("../middlewares/requirePlatformPermission");
const { verifyProjectShellToken } = require("../middlewares/auth");

const SECRET = "unit-test-only-secret-z2";
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const ISSUER = `https://login.microsoftonline.com/${DIR}/v2.0`;
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const PID = "6a0000000000000000000a02";
const TENANT = "68cbf7806080b4621d469d34";
const OTHER_TENANT = "6acd6119b28a863c61361ae0";
const USER = "6a00000000000000000000b1";
const USER2 = "6a00000000000000000000b2";

// In-memory store behind the two reads the evaluator makes.
let principals;
let users;
let failPrincipal = false;
let failUser = false;
const chain = (fn) => ({ select: () => ({ lean: async () => fn() }) });
function principal(o = {}) {
  return { _id: PID, issuer: ISSUER, oid: OID, tid: DIR, status: "active", revision: 4, permissions: ["platform:tenant:read:any"], ...o };
}
function crmUser(o = {}) {
  return { _id: USER, tenantId: TENANT, userType: "CRM", userMicrosoftId: OID, userIssuer: ISSUER, isActive: true, userEmail: "ops@example.org", ...o };
}

const sign = (claims, opts = {}) => jwt.sign({ id: USER, sub: USER, tenantId: TENANT, userType: "CRM", roles: [], permissions: [], ...claims }, opts.secret || SECRET, { algorithm: "HS256", expiresIn: "10m" });
const plat = (o = {}) => ({ v: 1, pid: PID, rev: 4, ...o });
const ctx = (o = {}) => ({ userId: USER, tenantId: TENANT, roles: [], permissions: [], ...o });
const evalWith = (token, permission = "platform:tenant:read:any", c = ctx()) =>
  evaluatePlatformPermission({ authorization: token === null ? undefined : `Bearer ${token}`, ctx: c, permission, verifyToken: verifyProjectShellToken });

let logs;
beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.PLATFORM_AUTH_MODE = "shadow";
  principals = new Map([[PID, principal()]]);
  users = [crmUser()];
  failPrincipal = false;
  failUser = false;
  logs = [];
  jest.spyOn(PlatformPrincipal, "findById").mockImplementation((id) => chain(() => {
    if (failPrincipal) throw Object.assign(new Error("connection refused mongodb://u:p@h"), { name: "MongoNetworkError" });
    return principals.get(String(id)) || null;
  }));
  jest.spyOn(User, "findOne").mockImplementation((q) => chain(() => {
    if (failUser) throw new Error("boom");
    return users.find((u) => String(u._id) === String(q._id) && String(u.tenantId) === String(q.tenantId)) || null;
  }));
  jest.spyOn(console, "info").mockImplementation((...a) => logs.push(a.join(" ")));
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.PLATFORM_AUTH_MODE;
  delete process.env.JWT_SECRET;
});

describe("catalogue after the Z2 renames (owner decision D1)", () => {
  test("exactly the 10 approved codes", () => {
    expect([...PLATFORM_PERMISSIONS].sort()).toEqual([
      "platform:cache:admin", "platform:permission-catalogue:manage", "platform:principals:manage",
      "platform:provisioning:admin", "platform:reference-data:manage", "platform:tenant:auth-connections:manage:any",
      "platform:tenant:create", "platform:tenant:delete:any", "platform:tenant:read:any", "platform:tenant:update:any",
    ]);
  });
  test.each(["platform:tenant:read", "platform:tenant:update", "platform:tenant:delete", "platform:tenant:auth-connections:manage", "platform:permissions:manage", "platform:catalogue:manage", "*", "platform:*", "tenant:read"])(
    "old / wildcard code %s is not a platform permission", (c) => expect(isPlatformPermission(c)).toBe(false));
  test("model rejects an old code, accepts the renamed one", async () => {
    const base = { issuer: ISSUER, oid: OID, tid: DIR, createdBy: "ops", updatedBy: "ops" };
    await expect(new PlatformPrincipal({ ...base, permissions: ["platform:tenant:read"] }).validate()).rejects.toThrow();
    await expect(new PlatformPrincipal({ ...base, permissions: ["platform:tenant:read:any"] }).validate()).resolves.toBeUndefined();
  });
});

describe("evaluator decision sequence", () => {
  test("active, current revision, bound user, exact permission -> allowed", async () => {
    const d = await evalWith(sign({ plat: plat() }));
    expect(d).toMatchObject({ allowed: true, status: 200, reason: REASONS.ALLOWED, pid: PID, tokenRev: 4, currentRev: 4, revMatch: true });
  });
  test("missing Authorization -> 401 jwt_missing; no lookup", async () => {
    expect(await evalWith(null)).toMatchObject({ allowed: false, status: 401, reason: "jwt_missing" });
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  });
  test.each([
    ["wrong secret", () => sign({ plat: plat() }, { secret: "another-secret" })],
    ["alg none", () => `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ id: USER, tenantId: TENANT, plat: plat() })).toString("base64url")}.`],
    ["expired", () => jwt.sign({ id: USER, tenantId: TENANT, plat: plat(), exp: Math.floor(Date.now() / 1000) - 600 }, SECRET)],
    ["garbage", () => "not.a.jwt"],
  ])("%s token -> 401 jwt_invalid; no lookup", async (_n, tok) => {
    expect(await evalWith(tok())).toMatchObject({ allowed: false, status: 401, reason: "jwt_invalid" });
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  });
  test.each([
    ["other user in ctx", ctx({ userId: USER2 })],
    ["other tenant in ctx", ctx({ tenantId: OTHER_TENANT })],
    ["no ctx", null],
  ])("token identity != request identity (%s) -> 401 jwt_ctx_mismatch", async (_n, c) => {
    expect(await evalWith(sign({ plat: plat() }), "platform:tenant:read:any", c)).toMatchObject({ status: 401, reason: "jwt_ctx_mismatch" });
  });
  test("no plat -> 403 no_plat (ordinary user, legacy SU with '*', ASU alike); no lookup", async () => {
    for (const claims of [{}, { roles: [{ code: "SU" }], permissions: ["*"] }, { roles: [{ code: "ASU" }], permissions: ["tenant:admin"] }]) {
      expect(await evalWith(sign(claims), "platform:tenant:read:any", ctx({ roles: ["SU"], permissions: ["*"] }))).toMatchObject({ allowed: false, status: 403, reason: "no_plat" });
    }
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  });
  test.each([
    ["extra key", { ...plat(), perms: ["platform:tenant:read:any"] }],
    ["missing rev", { v: 1, pid: PID }],
    ["rev 0", plat({ rev: 0 })],
    ["rev string", plat({ rev: "4" })],
    ["pid upper-case", plat({ pid: PID.toUpperCase() })],
    ["pid short", plat({ pid: "6a00" })],
    ["v string", plat({ v: "1" })],
    ["array", [1, PID, 4]],
    ["string", "platform"],
    ["true", true],
  ])("malformed plat (%s) -> 403 malformed_plat; no lookup", async (_n, p) => {
    expect(await evalWith(sign({ plat: p }))).toMatchObject({ allowed: false, status: 403, reason: "malformed_plat" });
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  });
  test("plat.v = 2 -> 403 bad_version; no lookup", async () => {
    expect(await evalWith(sign({ plat: plat({ v: 2 }) }))).toMatchObject({ status: 403, reason: "bad_version" });
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  });
  test("unknown pid -> 403 not_found", async () => {
    expect(await evalWith(sign({ plat: plat({ pid: "6a0000000000000000000fff" }) }))).toMatchObject({ status: 403, reason: "not_found" });
  });
  test("disabled principal -> 403 disabled", async () => {
    principals.set(PID, principal({ status: "disabled", revision: 4 }));
    expect(await evalWith(sign({ plat: plat() }))).toMatchObject({ status: 403, reason: "disabled" });
  });
  test.each([3, 5])("stale revision (token rev %i vs 4) -> 403 stale_rev", async (rev) => {
    expect(await evalWith(sign({ plat: plat({ rev }) }))).toMatchObject({ status: 403, reason: "stale_rev", tokenRev: rev, currentRev: 4, revMatch: false });
  });
  test.each([
    ["user re-bound to another oid (same email)", { userMicrosoftId: "bbbb1111-bbbb-2222-cccc-3333dddd4444" }],
    ["user issuer is another directory", { userIssuer: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0" }],
    ["user deactivated", { isActive: false }],
    ["PORTAL user", { userType: "PORTAL" }],
    ["user has no Microsoft id", { userMicrosoftId: null }],
  ])("binding lost: %s -> 403 binding_lost", async (_n, o) => {
    users = [crmUser(o)];
    expect(await evalWith(sign({ plat: plat() }))).toMatchObject({ status: 403, reason: "binding_lost" });
  });
  test("binding: the token user no longer exists (or exists only in another tenant) -> 403 binding_lost", async () => {
    users = [crmUser({ tenantId: OTHER_TENANT })];
    expect(await evalWith(sign({ plat: plat() }))).toMatchObject({ status: 403, reason: "binding_lost" });
  });
  test("another user of the same directory carrying the principal's pid/rev -> 403 binding_lost", async () => {
    users = [crmUser(), crmUser({ _id: USER2, userMicrosoftId: "cccc1111-bbbb-2222-cccc-3333dddd4444", userEmail: "ops@example.org" })];
    const t = sign({ id: USER2, sub: USER2, plat: plat() });
    expect(await evalWith(t, "platform:tenant:read:any", ctx({ userId: USER2 }))).toMatchObject({ status: 403, reason: "binding_lost" });
  });
  test("active, current, bound, permission missing -> 403 permission_missing", async () => {
    expect(await evalWith(sign({ plat: plat() }), "platform:tenant:create")).toMatchObject({ status: 403, reason: "permission_missing" });
  });
  test("one permission never implies another; '*' / 'platform:*' / prefixes held never match", async () => {
    principals.set(PID, principal({ permissions: ["platform:cache:admin"] }));
    for (const p of PLATFORM_PERMISSIONS.filter((c) => c !== "platform:cache:admin")) {
      expect((await evalWith(sign({ plat: plat() }), p)).reason).toBe("permission_missing");
    }
    // Stored by bypassing the schema enum: still no match.
    principals.set(PID, principal({ permissions: ["*", "platform:*", "platform:tenant", "platform:tenant:read", "PLATFORM:TENANT:READ:ANY"] }));
    for (const p of PLATFORM_PERMISSIONS) expect((await evalWith(sign({ plat: plat() }), p)).reason).toBe("permission_missing");
  });
  test("tenant '*' in the token / ctx does not help", async () => {
    const t = sign({ permissions: ["*"], roles: [{ code: "SU" }], plat: plat() });
    expect(await evalWith(t, "platform:tenant:create", ctx({ roles: ["SU"], permissions: ["*"] }))).toMatchObject({ status: 403, reason: "permission_missing" });
  });
  test("principal lookup error -> 403 lookup_error (fail closed); user lookup error too", async () => {
    failPrincipal = true;
    expect(await evalWith(sign({ plat: plat() }))).toMatchObject({ allowed: false, status: 403, reason: "lookup_error" });
    failPrincipal = false;
    failUser = true;
    expect(await evalWith(sign({ plat: plat() }))).toMatchObject({ allowed: false, status: 403, reason: "lookup_error" });
  });
  test("non-catalogue permission is a programming error", async () => {
    await expect(evalWith(sign({ plat: plat() }), "platform:*")).rejects.toThrow();
  });
});

// ---- HTTP: probe (enforcing) and an observed route (shadow) -------------------------------------
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", require("../routes/platformProbe.routes").router);
  // An observed route: the observer, then a legacy SU-style guard decides (as on the real routes).
  app.post("/api/observed", require("../middlewares/auth").authenticate, observePlatformPermission("platform:tenant:create"),
    (req, res, next) => ((req.ctx?.roles || []).includes("SU") ? next() : res.status(403).json({ legacy: "denied" })),
    (req, res) => res.status(201).json({ legacy: "allowed", platform: req.platform || null }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

function request(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const who = (o = {}) => ({ "x-test-tenant": TENANT, "x-test-user": USER, ...o });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const probe = (code, headers) => request("GET", `/api/platform/authz-probe/${encodeURIComponent(code)}`, headers);
const PUBLIC_403 = JSON.stringify({ error: { message: "Platform authority required", code: "PLATFORM_AUTHORITY_REQUIRED", status: 403 } });

describe("DEV probe (route-enforce)", () => {
  test("allowed -> 200 { allowed, permission } and nothing else", async () => {
    const r = await probe("platform:tenant:read:any", { ...who(), ...bearer(sign({ plat: plat() })) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ allowed: true, permission: "platform:tenant:read:any" });
    expect(r.body).not.toMatch(new RegExp(`${PID}|${OID}|${ISSUER.replace(/[./]/g, ".")}|revision|status|example`));
  });
  test("every platform-authority failure -> the SAME public 403 body", async () => {
    const cases = [
      () => sign({}), () => sign({ plat: plat({ v: 2 }) }), () => sign({ plat: { v: 1, pid: PID } }),
      () => sign({ plat: plat({ pid: "6a0000000000000000000fff" }) }), () => sign({ plat: plat({ rev: 3 }) }),
    ];
    const bodies = new Set();
    for (const c of cases) {
      const r = await probe("platform:tenant:read:any", { ...who(), ...bearer(c()) });
      expect(r.status).toBe(403);
      bodies.add(r.body);
    }
    principals.set(PID, principal({ status: "disabled" }));
    bodies.add((await probe("platform:tenant:read:any", { ...who(), ...bearer(sign({ plat: plat() })) })).body);
    principals.set(PID, principal());
    users = [crmUser({ userMicrosoftId: "bbbb1111-bbbb-2222-cccc-3333dddd4444" })];
    bodies.add((await probe("platform:tenant:read:any", { ...who(), ...bearer(sign({ plat: plat() })) })).body);
    users = [crmUser()];
    bodies.add((await probe("platform:tenant:create", { ...who(), ...bearer(sign({ plat: plat() })) })).body);
    failPrincipal = true;
    bodies.add((await probe("platform:tenant:read:any", { ...who(), ...bearer(sign({ plat: plat() })) })).body);
    expect([...bodies]).toEqual([PUBLIC_403]);
  });
  test("no / invalid JWT or identity mismatch -> 401", async () => {
    expect((await probe("platform:tenant:read:any", who())).status).toBe(401);
    expect((await probe("platform:tenant:read:any", { ...who(), ...bearer(sign({ plat: plat() }, { secret: "x" })) })).status).toBe(401);
    expect((await probe("platform:tenant:read:any", { ...who({ "x-test-user": USER2 }), ...bearer(sign({ plat: plat() })) })).status).toBe(401);
  });
  test("forged plat in body / query / x-platform-* headers does nothing (valid JWT without plat)", async () => {
    const forged = { "x-platform-principal": PID, "x-platform-permissions": '["platform:tenant:read:any"]', "X-Platform-Rev": "4", "x-plat": JSON.stringify(plat()) };
    const r1 = await request("GET", `/api/platform/authz-probe/platform:tenant:read:any?plat=${encodeURIComponent(JSON.stringify(plat()))}&pid=${PID}`, { ...who(), ...bearer(sign({})), ...forged });
    expect(r1.status).toBe(403);
    const r2 = await request("GET", "/api/platform/authz-probe/platform:tenant:read:any", { ...who(), ...bearer(sign({})), ...forged }, { plat: plat() });
    expect(r2.body).toBe(PUBLIC_403);
    expect(r1.body).toBe(PUBLIC_403);
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  });
  test("legacy SU with '*' and ASU without plat -> 403", async () => {
    for (const roles of [["SU"], ["ASU"]]) {
      const r = await probe("platform:cache:admin", { ...who({ "x-test-roles": JSON.stringify(roles), "x-test-perms": '["*"]' }), ...bearer(sign({ roles: roles.map((code) => ({ code })), permissions: ["*"] })) });
      expect(r.status).toBe(403);
    }
  });
  test("unknown / wildcard / old code -> 400, nothing evaluated", async () => {
    for (const c of ["*", "platform:*", "platform:tenant:read", "tenant:read"]) {
      expect((await probe(c, { ...who(), ...bearer(sign({ plat: plat() })) })).status).toBe(400);
    }
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
  });
  test("PLATFORM_AUTH_MODE=off -> the probe denies (403) without any lookup or log", async () => {
    process.env.PLATFORM_AUTH_MODE = "off";
    const r = await probe("platform:tenant:read:any", { ...who(), ...bearer(sign({ plat: plat() })) });
    expect(r.status).toBe(403);
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
  test("probe enforces in global shadow mode too", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    expect((await probe("platform:tenant:read:any", { ...who(), ...bearer(sign({})) })).status).toBe(403);
  });
  test("probe flag: router mounted only when PLATFORM_AUTHZ_PROBE is exactly 'on'", () => {
    const { probeEnabled } = require("../routes/platformProbe.routes");
    for (const [v, want] of [["on", true], ["ON", false], ["1", false], ["true", false], [undefined, false]]) {
      if (v === undefined) delete process.env.PLATFORM_AUTHZ_PROBE; else process.env.PLATFORM_AUTHZ_PROBE = v;
      expect(probeEnabled()).toBe(want);
    }
    process.env.PLATFORM_AUTHZ_PROBE = "on";
  });
});

describe("observer (shadow-capped)", () => {
  const ident = [
    ["legacy SU with '*'", who({ "x-test-roles": '["SU"]', "x-test-perms": '["*"]' }), () => sign({ roles: [{ code: "SU" }], permissions: ["*"] })],
    ["ASU", who({ "x-test-roles": '["ASU"]' }), () => sign({ roles: [{ code: "ASU" }] })],
    ["ordinary user", who({ "x-test-roles": '["REO"]' }), () => sign({ roles: [{ code: "REO" }] })],
    ["allowed principal, not SU", who(), () => sign({ plat: plat() })],
  ];
  test.each(["shadow", "enforce"])("global %s: status/body identical to mode off for every identity; never grants or denies", async (mode) => {
    principals.set(PID, principal({ permissions: ["platform:tenant:create"] }));
    for (const [, h, tok] of ident) {
      process.env.PLATFORM_AUTH_MODE = "off";
      const before = await request("POST", "/api/observed", { ...h, ...bearer(tok()) }, {});
      process.env.PLATFORM_AUTH_MODE = mode;
      const after = await request("POST", "/api/observed", { ...h, ...bearer(tok()) }, {});
      expect(after).toEqual(before);
      expect(after.body).not.toMatch(/"platform":\{/); // shadow never sets req.platform
    }
  });
  test("decision recorded per request: no_plat for SU / ASU / ordinary; allowed only for the real principal", async () => {
    principals.set(PID, principal({ permissions: ["platform:tenant:create"] }));
    for (const [, h, tok] of ident) await request("POST", "/api/observed", { ...h, ...bearer(tok()) }, {});
    const parsed = logs.filter((l) => l.startsWith("[platform-authz]")).map((l) => JSON.parse(l.slice("[platform-authz] ".length)));
    expect(parsed.map((d) => [d.effective, d.reason, d.allowed])).toEqual([
      ["shadow", "no_plat", false], ["shadow", "no_plat", false], ["shadow", "no_plat", false], ["shadow", "allowed", true],
    ]);
    expect(parsed[3]).toMatchObject({ permission: "platform:tenant:create", pid: "…000a02", tokenRev: 4, currentRev: 4, revMatch: true, actorTenantId: TENANT, actorUserId: "…0000b1" });
  });
  test("observer swallows evaluator errors and continues", async () => {
    failPrincipal = true;
    const r = await request("POST", "/api/observed", { ...who({ "x-test-roles": '["SU"]' }), ...bearer(sign({ plat: plat() })) }, {});
    expect(r.status).toBe(201);
  });
  test("mode off: no evaluation and no log", async () => {
    process.env.PLATFORM_AUTH_MODE = "off";
    await request("POST", "/api/observed", { ...who(), ...bearer(sign({ plat: plat() })) }, {});
    expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
});

describe("middleware construction and logs", () => {
  test("unknown code / mode throws at route definition", () => {
    expect(() => observePlatformPermission("platform:*")).toThrow();
    expect(() => requirePlatformPermission("*")).toThrow();
    expect(() => requirePlatformPermission("platform:tenant:read")).toThrow();
    expect(() => requirePlatformPermission("platform:cache:admin", { mode: "enforce" })).toThrow();
  });
  test("log lines never contain the JWT, the Authorization header, oid, issuer, email or a full id", async () => {
    const tok = sign({ plat: plat() });
    await probe("platform:tenant:read:any", { ...who(), ...bearer(tok) });
    failPrincipal = true;
    await probe("platform:tenant:read:any", { ...who(), ...bearer(tok) });
    const all = logs.join("\n");
    expect(logs.length).toBe(2);
    for (const s of [tok, tok.split(".")[1], "Bearer", OID, DIR, "@", PID, USER, "mongodb://"]) expect(all).not.toContain(s);
  });
});
