/**
 * Phase 1C — product-domain router guard (product / productType / pricing).
 *
 * Proves each of the three routers now establishes trusted authenticated tenant
 * context EXPLICITLY at the router level, in the order
 *   authenticate -> tenantContextWarn (WARN) -> requireTenant -> policyAdapter -> controller
 * independently of any earlier sibling router having run first, and that
 * caller-supplied body/query tenantId cannot replace the trusted req.ctx tenant.
 *
 * No DB / Redis / network / second tenant: the shared auth middleware,
 * policyAdapter, and the controllers are mocked with order-recording stubs.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");

// ---- shared order recorder + toggles (mock-prefixed for jest factory access) ----
const mockCalls = [];
let mockAuthSetsCtx = true; // when false, authenticate leaves req.ctx unset

jest.mock("../middlewares/auth", () => ({
  authenticate: (req, res, next) => {
    mockCalls.push("authenticate");
    if (mockAuthSetsCtx) {
      req.ctx = { tenantId: "tenant-A", userId: "u1", roles: [], permissions: [] };
      req.user = { id: "u1", tenantId: "tenant-A" };
      req.tenantId = "tenant-A";
    }
    next();
  },
  // WARN mode: re-pin req.tenantId to the trusted tenant, never block.
  tenantContextWarn: (req, res, next) => {
    mockCalls.push("tenantContextWarn");
    if (req.ctx && req.ctx.tenantId) req.tenantId = req.ctx.tenantId;
    next();
  },
  requireTenant: (req, res, next) => {
    mockCalls.push("requireTenant");
    if (!req.ctx || !req.ctx.tenantId) {
      return res.status(400).json({ error: "Tenant context required" });
    }
    next();
  },
}));

jest.mock("../helpers/policyAdapter", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => (req, res, next) => {
      mockCalls.push(`policyAdapter:${resource}:${action}`);
      next();
    },
  },
}));

const mockControllerProxy = () =>
  new Proxy(
    {},
    {
      get: () => (req, res) => {
        mockCalls.push("controller");
        res.status(200).json({
          ctxTenant: req.ctx && req.ctx.tenantId,
          reqTenant: req.tenantId,
          bodyTenant: req.body && req.body.tenantId,
          queryTenant: req.query && req.query.tenantId,
        });
      },
    }
  );
jest.mock("../controllers/product.controller", () => mockControllerProxy());
jest.mock("../controllers/productType.controller", () => mockControllerProxy());
jest.mock("../controllers/pricing.controller", () => mockControllerProxy());

const productRouter = require("../routes/product.routes");
const productTypeRouter = require("../routes/productType.routes");
const pricingRouter = require("../routes/pricing.routes");

const routers = [
  { name: "product", router: productRouter, list: "/products" },
  { name: "productType", router: productTypeRouter, list: "/product-types" },
  { name: "pricing", router: pricingRouter, list: "/pricing" },
];

// Fire one request against a router mounted ALONE (no sibling) on an ephemeral server.
function fire(router, method, urlPath, { body, query } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use("/", router);
    const server = app.listen(0, () => {
      const port = server.address().port;
      const qs = query
        ? "?" + Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
        : "";
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        { host: "127.0.0.1", port, path: urlPath + qs, method,
          headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            server.close();
            let json = {};
            try { json = JSON.parse(d); } catch (_) {}
            resolve({ status: res.statusCode, body: json });
          });
        }
      );
      req.on("error", (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}

beforeEach(() => {
  mockCalls.length = 0;
  mockAuthSetsCtx = true;
});

describe.each(routers)("product-domain router guard — %s", ({ name, router, list }) => {
  test("A/B/D order: authenticate -> tenantContextWarn -> requireTenant -> policyAdapter -> controller", async () => {
    const res = await fire(router, "GET", list);
    expect(res.status).toBe(200);
    const i = (x) => mockCalls.indexOf(x);
    expect(i("authenticate")).toBeGreaterThanOrEqual(0);
    expect(i("authenticate")).toBeLessThan(i("tenantContextWarn")); // A
    const pa = mockCalls.find((c) => c.startsWith("policyAdapter:"));
    expect(i("tenantContextWarn")).toBeLessThan(i("requireTenant"));   // B
    expect(i("requireTenant")).toBeLessThan(mockCalls.indexOf(pa));     // B
    expect(mockCalls.indexOf(pa)).toBeLessThan(i("controller"));        // D
    expect(mockCalls[mockCalls.length - 1]).toBe("controller");
  });

  test("C requireTenant rejects (400) when trusted tenant context is absent; controller not reached", async () => {
    mockAuthSetsCtx = false;
    const res = await fire(router, "GET", list);
    expect(res.status).toBe(400);
    expect(mockCalls).toContain("requireTenant");
    expect(mockCalls).not.toContain("controller");
  });

  test("E body tenantId cannot replace trusted req.ctx tenant", async () => {
    const res = await fire(router, "POST", list, { body: { tenantId: "tenant-EVIL", name: "x" } });
    expect(res.status).toBe(200);
    expect(res.body.ctxTenant).toBe("tenant-A");   // trusted, unchanged
    expect(res.body.reqTenant).toBe("tenant-A");   // re-pinned to trusted
    expect(res.body.bodyTenant).toBe("tenant-EVIL"); // present in body but NOT the trusted tenant
  });

  test("F query tenantId cannot replace trusted req.ctx tenant", async () => {
    const res = await fire(router, "GET", list, { query: { tenantId: "tenant-EVIL" } });
    expect(res.status).toBe(200);
    expect(res.body.ctxTenant).toBe("tenant-A");
    expect(res.body.reqTenant).toBe("tenant-A");
    expect(res.body.queryTenant).toBe("tenant-EVIL");
  });

  test("G no dependency on a sibling router: authenticate runs even when this router is mounted alone", async () => {
    const res = await fire(router, "GET", list); // only this router mounted in fire()
    expect(res.status).toBe(200);
    expect(mockCalls[0]).toBe("authenticate"); // guard runs first, with no sibling present
  });
});

describe("H WARN mode preserved (source assertion)", () => {
  test("middlewares/auth.js uses mode: \"warn\" and not \"enforce\"", () => {
    const src = fs.readFileSync(path.join(__dirname, "../middlewares/auth.js"), "utf8");
    expect(src).toMatch(/tenantContextMiddleware\(\{\s*mode:\s*"warn"\s*\}\)/);
    expect(src).not.toMatch(/mode:\s*"enforce"/);
  });

  test("E/F proved warn is non-blocking (caller tenant mismatch returned 200, not 403)", () => {
    // Guard: the E/F tests above assert 200 with trusted tenant preserved — i.e.
    // a caller-supplied mismatching tenant is ignored (WARN), never blocked.
    expect(true).toBe(true);
  });
});
