/**
 * Phase 1A FIRST-CONSUMER ADOPTION — user-service tenant-context guard (WARN MODE).
 *
 * Verifies two things:
 *  (A) behaviour of the warn-mode canonical tenant-context middleware that user-service now
 *      consumes from @membership/policy-middleware@257a297 (identical to the exported
 *      `tenantContextWarn` in middlewares/auth.js), and
 *  (B) that the adoption is wired correctly — auth.js builds/exports it in WARN mode, every
 *      authenticated router pairs it AFTER `authenticate`, and no pre-auth / internal /
 *      unauthenticated router mounts it.
 *
 * The behaviour tests build their own `tenantContextMiddleware({ mode: "warn" })` instead of
 * requiring middlewares/auth.js, because auth.js transitively opens a Redis client
 * (roleHierarchyService) that never resolves in a unit-test environment. The wiring tests read
 * source statically for the same reason. `tenantContextWarn` is exactly
 * `tenantContextMiddleware({ mode: "warn" })`, so the behaviour asserted here is the behaviour
 * mounted on the routes.
 *
 * Run: npx jest tests/tenantContext.adoption.test.js
 */
const os = require("os");
const path = require("path");
const fs = require("fs");

// Point logging-lib's file transport at a throwaway dir before the package (and its logger)
// is required, so these tests never touch the real /var/log path.
process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "us-tenantctx-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const policyMw = require("@membership/policy-middleware");
const { tenantContextMiddleware } = policyMw;

const TRUSTED = "68cbf7806080b4621d469d34"; // INMO Tenant._id
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaa"; // a different (spoofed) tenant id

// The exact instance the routes mount.
const tenantContextWarn = tenantContextMiddleware({ mode: "warn" });

function gatewayReq(overrides = {}) {
  return {
    method: "GET",
    url: "/api/roles",
    originalUrl: "/api/roles",
    headers: {
      "x-jwt-verified": "true",
      "x-auth-source": "gateway",
      "x-user-id": "U1",
      "x-tenant-id": TRUSTED,
      ...(overrides.headers || {}),
    },
    // authenticate() sets these; mirror them so getTrustedTenant sees a trusted tenant.
    ctx: overrides.ctx !== undefined ? overrides.ctx : { tenantId: TRUSTED, userId: "U1" },
    tenantId: overrides.tenantId,
    body: overrides.body,
    query: overrides.query,
    params: overrides.params,
  };
}

function mkRes() {
  const r = { statusCode: null, body: null, _statusCalls: [] };
  r.status = (c) => {
    r.statusCode = c;
    r._statusCalls.push(c);
    return r;
  };
  r.json = (b) => {
    r.body = b;
    return r;
  };
  return r;
}

// Run the middleware capturing anything logging-lib writes to stdout, and how many times
// next() was called.
function run(req) {
  const res = mkRes();
  const orig = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (s) => (chunks.push(typeof s === "string" ? s : s.toString()), true);
  let nextCount = 0;
  try {
    tenantContextWarn(req, res, () => {
      nextCount += 1;
    });
  } finally {
    process.stdout.write = orig;
  }
  const rows = chunks
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean);
  return { req, res, nextCount, rows };
}

const readSrc = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// ---------------------------------------------------------------------------
// (A) Behaviour of the mounted warn-mode guard
// ---------------------------------------------------------------------------
describe("tenantContextWarn — behaviour (warn mode)", () => {
  test("1 pins req.tenantId to the gateway-verified trusted tenant and calls next()", () => {
    const { req, nextCount, res } = run(gatewayReq());
    expect(req.tenantId).toBe(TRUSTED);
    expect(nextCount).toBe(1);
    expect(res.statusCode).toBeNull();
  });

  test("2 ignores a caller-supplied body.tenantId (spoof is NOT applied to scope)", () => {
    const { req, nextCount } = run(gatewayReq({ body: { tenantId: OTHER } }));
    expect(req.tenantId).toBe(TRUSTED); // trusted stays authoritative
    expect(nextCount).toBe(1);
  });

  test("3 ignores caller-supplied query.tenantId and params.tenantId", () => {
    const q = run(gatewayReq({ query: { tenantId: OTHER } }));
    expect(q.req.tenantId).toBe(TRUSTED);
    const p = run(gatewayReq({ params: { tenantId: OTHER } }));
    expect(p.req.tenantId).toBe(TRUSTED);
  });

  test("4 warn mode NEVER blocks on mismatch (no 403, next() still called once)", () => {
    const { res, nextCount } = run(gatewayReq({ body: { tenantId: OTHER } }));
    expect(res._statusCalls).not.toContain(403);
    expect(res.statusCode).toBeNull();
    expect(nextCount).toBe(1);
  });

  test("5 emits a non-blocking TenantContextMismatch log for a body mismatch", () => {
    const { rows } = run(gatewayReq({ body: { tenantId: OTHER } }));
    const row = rows.find((r) => r.eventType === "TenantContextMismatch");
    expect(row).toBeTruthy();
    expect(row.mode).toBe("warn");
    expect(row.outcome).toBe("ignored");
    expect(row.trustedTenantId).toBe(TRUSTED);
    expect(row.suppliedSources).toContain("body");
    expect(row.service).toBe("policy-middleware");
  });

  test("6 no mismatch log when the supplied tenantId equals the trusted tenant", () => {
    const { rows, nextCount } = run(gatewayReq({ body: { tenantId: TRUSTED } }));
    expect(rows.find((r) => r.eventType === "TenantContextMismatch")).toBeUndefined();
    expect(nextCount).toBe(1);
  });

  test("7 x-tenant-id header is trusted ONLY when x-jwt-verified===true", () => {
    // No x-jwt-verified, no ctx: the header tenant must NOT become the trusted scope.
    const req = gatewayReq({
      headers: { "x-jwt-verified": undefined, "x-tenant-id": OTHER },
      ctx: null,
      tenantId: undefined,
    });
    const { nextCount } = run(req);
    expect(req.tenantId).toBeUndefined(); // untrusted header ignored
    expect(nextCount).toBe(1); // still non-blocking
  });

  test("8 falls back to req.ctx.tenantId when the gateway header is absent", () => {
    const req = gatewayReq({
      headers: { "x-jwt-verified": undefined },
      ctx: { tenantId: TRUSTED, userId: "U1" },
    });
    const { nextCount } = run(req);
    expect(req.tenantId).toBe(TRUSTED);
    expect(nextCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (B) Adoption wiring
// ---------------------------------------------------------------------------
describe("tenantContextWarn — adoption wiring", () => {
  test("9 installed @membership/policy-middleware exposes the Phase 1A primitives", () => {
    expect(typeof policyMw.resolveTenantContext).toBe("function");
    expect(typeof policyMw.tenantContextMiddleware).toBe("function");
  });

  test("10 middlewares/auth.js builds it in WARN mode and exports tenantContextWarn", () => {
    const src = readSrc("middlewares/auth.js");
    expect(src).toMatch(/tenantContextMiddleware\s*,?\s*\}\s*=\s*require\(["']@membership\/policy-middleware["']\)/s);
    expect(src).toMatch(/tenantContextWarn\s*=\s*tenantContextMiddleware\(\{\s*mode:\s*["']warn["']\s*\}\)/);
    // exported
    expect(src).toMatch(/module\.exports\s*=\s*\{[\s\S]*tenantContextWarn[\s\S]*\}/);
  });

  test("11 every authenticated router mounts it AFTER authenticate", () => {
    const routers = [
      "role.routes.js",
      "tenant.routes.js",
      "permission.routes.js",
      "tenantOffice.routes.js",
      "tenantPublicHoliday.routes.js",
      "tenantDepartment.routes.js",
      "tenantContact.routes.js",
      "tenantScoped.routes.js",
      "cache.routes.js",
      "lookup.router.js",
      "user.routes.js",
    ];
    for (const r of routers) {
      const src = readSrc(path.join("routes", r));
      expect(src).toMatch(/require\(["']\.\.\/middlewares\/auth["']\)/);
      expect(src).toContain("tenantContextWarn");
      // paired on the same group mount => authenticate runs first, guard immediately after
      expect(src).toMatch(/router\.use\(\s*authenticate\s*,\s*tenantContextWarn\s*\)/);
    }
    // /api/me applies them per-route: authenticate must precede tenantContextWarn.
    const me = readSrc(path.join("routes", "me.routes.js"));
    expect(me).toContain("tenantContextWarn");
    expect(me.indexOf("authenticate")).toBeLessThan(me.lastIndexOf("tenantContextWarn"));
  });

  test("12 pre-auth / internal / unauthenticated routers do NOT mount it", () => {
    const excluded = [
      "auth.routes.js",
      "token.routes.js",
      "pkce.routes.js",
      "sessions.routes.js",
      "policy.routes.js",
      "tenantLifecycle.routes.js",
      "internalRoleAccess.routes.js",
      "internalMsTokenVerification.routes.js",
      "lookuptype.router.js",
      "productType.routes.js",
      "product.routes.js",
      "pricing.routes.js",
      "country.routes.js",
      "contact.routes.js",
      "contactType.routes.js",
    ];
    for (const r of excluded) {
      const src = readSrc(path.join("routes", r));
      expect(src).not.toContain("tenantContextWarn");
    }
  });
});
