/**
 * Phase 2B0 — POST /token/generate-test is removed.
 *
 * It minted a JWT_SECRET-signed 24h token for any caller-supplied userId/tenantId with no
 * authentication. /token is mounted at the service root (not under /api), so it was reachable
 * from anything on the Docker network/VNet. There is no replacement route; normal JWT issuance
 * (helpers/jwt.js generateToken, refresh, Azure/B2C login) is untouched.
 *
 * Mounts the real token router with no DB / Redis / network.
 */
const http = require("http");
const express = require("express");

const tokenRouter = require("../routes/token.routes");
const tokenController = require("../controllers/token.controller");

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/token", tokenRouter);
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      `${base}${url}`,
      { method, headers: { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, raw, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const routeTable = () =>
  tokenRouter.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

describe("token.routes.js — generate-test removed (Phase 2B0)", () => {
  test("A /generate-test is not declared; the other token routes are unchanged", () => {
    expect(routeTable()).not.toContain("POST /generate-test");
    expect(routeTable()).toEqual(["POST /decode-token", "GET /validate-jwt", "GET /validate"]);
  });

  test("B the dead handler is gone from the controller", () => {
    expect(tokenController.generateTestToken).toBeUndefined();
    expect(typeof tokenController.decodeToken).toBe("function");
    expect(typeof tokenController.validateInternalJWT).toBe("function");
    expect(typeof tokenController.validateTokenForService).toBe("function");
  });

  test("C POST /token/generate-test returns 404 and issues no token (even with a body tenantId)", async () => {
    const res = await request("POST", "/token/generate-test", {
      userId: "attacker",
      tenantId: "tenant-B",
      email: "x@example.com",
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ notFound: true });
    expect(res.raw).not.toMatch(/Bearer|token/i);
  });
});
