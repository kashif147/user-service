/**
 * Phase 1C-2A — legacy local register/login are no longer exposed by routes/user.routes.js.
 *
 * Their handlers resolve the tenant from req.body.tenantId, so any authenticated caller could
 * create a CRM user (and receive a token) in another tenant. The routes were removed; the gateway
 * also denies /user-service/api/users/{register,login}. Phase 2B removed the handlers themselves
 * along with /auth/general-crm/* (see authRoutes.generalCrmRemoved.test.js); the stubs below just
 * prove nothing on this router reaches them.
 *
 * Mounts the real router with order-recording stubs: no DB / Redis / network.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");

const mockCalls = [];

jest.mock("../middlewares/auth", () => ({
  authenticate: (req, res, next) => {
    mockCalls.push("authenticate");
    req.ctx = { tenantId: "tenant-A", userId: "u1" };
    next();
  },
  tenantContextWarn: (req, res, next) => (mockCalls.push("tenantContextWarn"), next()),
  requireTenant: (req, res, next) => (mockCalls.push("requireTenant"), next()),
}));
jest.mock("../middlewares/policy.middleware", () => ({
  defaultPolicyMiddleware: {
    requirePermission: (resource, action) => (req, res, next) => {
      mockCalls.push(`policy:${resource}:${action}`);
      next();
    },
  },
}));
jest.mock("../middlewares/basicAuth.middleware", () => ({
  azureB2CBasicAuth: () => (req, res, next) => (mockCalls.push("basicAuth"), next()),
}));
jest.mock("../controllers/user.controller", () => {
  const stub = (name) => (req, res) => {
    mockCalls.push(`controller:${name}`);
    res.status(299).json({ handler: name });
  };
  return {
    handleRegistration: stub("handleRegistration"),
    handleLogin: stub("handleLogin"),
    validateUser: stub("validateUser"),
    getUserByEmail: stub("getUserByEmail"),
  };
});

const userRouter = require("../routes/user.routes");

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", userRouter);
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => (mockCalls.length = 0));

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      `${base}${url}`,
      { method, headers: { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const routeTable = () =>
  userRouter.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

describe("user.routes.js exposure (Phase 1C-2A)", () => {
  test("A /users/register and /users/login are not declared", () => {
    expect(routeTable()).not.toContain("POST /users/register");
    expect(routeTable()).not.toContain("POST /users/login");
    expect(routeTable()).toEqual(["POST /users/validate", "GET /users/by-email/:email"]);
  });

  test.each(["/api/users/register", "/api/users/login"])(
    "B POST %s never reaches the register/login handlers (even with a body tenantId)",
    async (url) => {
      const res = await request("POST", url, { email: "x@example.com", password: "p", tenantId: "tenant-B" });
      expect(res.status).toBe(404);
      expect(mockCalls).not.toContain("controller:handleRegistration");
      expect(mockCalls).not.toContain("controller:handleLogin");
    }
  );

  test("C GET /users/by-email/:email keeps authenticate -> tenantContextWarn -> requireTenant -> policy", async () => {
    const res = await request("GET", "/api/users/by-email/a%40b.com");
    expect(res.status).toBe(299);
    expect(mockCalls).toEqual([
      "authenticate",
      "tenantContextWarn",
      "requireTenant",
      "policy:user:read",
      "controller:getUserByEmail",
    ]);
  });

  test("C POST /users/validate (B2C custom policy) is unchanged: basic auth, no JWT chain", async () => {
    const res = await request("POST", "/api/users/validate", { email: "a@b.com" });
    expect(res.status).toBe(299);
    expect(mockCalls).toEqual(["basicAuth", "controller:validateUser"]);
  });

  test("D auth.routes.js still declares its other auth endpoints (nothing unrelated removed)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "auth.routes.js"), "utf8");
    for (const p of ['"/azure-crm"', '"/azure-portal"', '"/refresh"', '"/logout"', '"/revoke"', '"/revoke-all"']) {
      expect(src).toContain(p);
    }
  });
});
