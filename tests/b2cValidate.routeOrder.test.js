/**
 * Phase 2D — POST /api/users/validate (Azure B2C API connector) through the REAL router
 * composition (routes/index.js), not user.routes.js in isolation.
 *
 * Bug: role.routes.js (and every other router mounted at "/api" before user.routes.js) runs
 * `router.use(authenticate, ...)` for ANY /api/* path, so the connector's request was rejected
 * with 400 "Authorization header required" before reaching its Basic-auth chain. The contract
 * (AZURE_B2C_INTEGRATION.md, userRoutes.exposure.test.js) is: Basic auth, no JWT chain.
 *
 * Real middlewares/auth.js and middlewares/basicAuth.middleware.js; only the user controller
 * is stubbed (tenant resolution itself is covered by b2cConnectorTenant.test.js).
 */
const http = require("http");
const express = require("express");

process.env.B2C_API_USERNAME = "b2c-connector";
process.env.B2C_API_PASSWORD = "connector-test-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "b2c-route-order-test-secret";

const reached = [];
jest.mock("../controllers/user.controller", () => {
  const actual = jest.requireActual("../controllers/user.controller");
  return {
    ...actual,
    validateUser: (req, res) => {
      reached.push({ handler: "validateUser", body: req.body });
      res.status(200).json({ version: "1.0.0", action: "Continue", stub: true });
    },
  };
});

const routes = require("../routes");

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", routes);
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => (reached.length = 0));

function request(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      `${base}${url}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const basic = (u, p) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` });
const connectorBody = { email: "new.member@example.com", client_id: "b2c-app-id" };

describe("POST /api/users/validate through routes/index.js", () => {
  test("A legitimate connector request (correct Basic auth, no JWT) reaches the controller", async () => {
    const res = await request("POST", "/api/users/validate", {
      body: connectorBody,
      headers: basic("b2c-connector", "connector-test-secret"),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: "Continue", stub: true });
    expect(reached).toHaveLength(1);
  });

  test("B wrong Basic password is blocked before the controller", async () => {
    const res = await request("POST", "/api/users/validate", {
      body: connectorBody,
      headers: basic("b2c-connector", "wrong"),
    });
    expect(res.body).toMatchObject({ action: "ShowBlockPage" });
    expect(reached).toHaveLength(0);
  });

  test("C missing Basic auth is blocked before the controller", async () => {
    const res = await request("POST", "/api/users/validate", { body: connectorBody });
    expect(res.body).toMatchObject({ action: "ShowBlockPage" });
    expect(reached).toHaveLength(0);
  });

  test("D a Bearer token instead of Basic does not open the connector", async () => {
    const res = await request("POST", "/api/users/validate", {
      body: connectorBody,
      headers: { authorization: "Bearer not-a-basic-credential" },
    });
    expect(res.body).toMatchObject({ action: "ShowBlockPage" });
    expect(reached).toHaveLength(0);
  });

  test("E body/header tenant claims are passed untouched; the router adds no tenant authority", async () => {
    await request("POST", "/api/users/validate", {
      body: { ...connectorBody, tenantId: "bbbbbbbbbbbbbbbbbbbbbbbb" },
      headers: { ...basic("b2c-connector", "connector-test-secret"), "x-tenant-id": "bbbbbbbbbbbbbbbbbbbbbbbb" },
    });
    expect(reached).toHaveLength(1);
    // The connector tenant comes only from resolveB2CConnectorTenantId(client_id)
    // (b2cConnectorTenant.test.js); nothing on this path sets req.tenantId from the claim.
    expect(reached[0].body.tenantId).toBe("bbbbbbbbbbbbbbbbbbbbbbbb");
  });
});

describe("normal /api routes still require a JWT", () => {
  test.each([
    ["GET", "/api/roles"],
    ["GET", "/api/users/by-email/a%40b.com"],
    ["GET", "/api/tenants"],
    ["GET", "/api/products"],
  ])("F %s %s without a token is rejected (4xx, never 2xx)", async (method, url) => {
    const res = await request(method, url);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(reached).toHaveLength(0);
  });

  test("G Basic connector credentials do not authenticate any other /api route", async () => {
    const res = await request("GET", "/api/roles", { headers: basic("b2c-connector", "connector-test-secret") });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("azureB2CBasicAuth without configured credentials", () => {
  const load = (env) => {
    const saved = { ...process.env };
    delete process.env.B2C_API_USERNAME; delete process.env.B2C_API_PASSWORD;
    delete process.env.BASIC_AUTH_USERNAME; delete process.env.BASIC_AUTH_PASSWORD;
    Object.assign(process.env, env);
    let mw;
    jest.isolateModules(() => { mw = require("../middlewares/basicAuth.middleware").azureB2CBasicAuth(); });
    process.env = saved;
    return mw;
  };
  const run = (mw) => {
    let nexted = false; let payload = null;
    const res = { setHeader() {}, status() { return this; }, json(b) { payload = b; return this; } };
    mw({ headers: {} }, res, () => (nexted = true));
    return { nexted, payload };
  };

  test.each(["staging", "production"])("H NODE_ENV=%s fails closed (route is never anonymous)", (env) => {
    const r = run(load({ NODE_ENV: env }));
    expect(r.nexted).toBe(false);
    expect(r.payload).toMatchObject({ action: "ShowBlockPage" });
  });

  test.each(["development", "test"])("I NODE_ENV=%s keeps the documented local no-op", (env) => {
    expect(run(load({ NODE_ENV: env })).nexted).toBe(true);
  });

  test("J configured credentials: the username is never logged; auth still enforced", () => {
    const logs = [];
    const spy = jest.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    let r;
    try {
      r = run(load({ NODE_ENV: "staging", B2C_API_USERNAME: "connector-user@b2c.example", B2C_API_PASSWORD: "pw-not-logged" }));
    } finally {
      spy.mockRestore();
    }
    expect(r.nexted).toBe(false); // no Authorization header -> still refused
    expect(logs.join("\n")).toMatch(/Basic Auth enabled/);
    expect(logs.join("\n")).not.toMatch(/connector-user|b2c\.example|pw-not-logged/);
  });
});
