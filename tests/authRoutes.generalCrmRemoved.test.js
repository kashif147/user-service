/**
 * Phase 2B — legacy /auth/general-crm/{register,login} are removed from source.
 *
 * Both resolved the tenant from req.body.tenantId (or x-tenant-id / DEFAULT_TENANT_ID), so a
 * caller could create a CRM user in, or obtain a token for, any tenant. /user-service/auth/* is
 * proxied without JWT checks, so these were only blocked by the gateway's 404 location (present
 * in the DEV gateway, absent from UAT's). CRM login is Azure AD (/auth/azure-crm) only. The dead
 * controller/handler register-login code and its Joi schema are removed too; there is no
 * replacement route.
 *
 * Mounts the real auth router with stubbed controllers: no DB / Redis / network.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");

const calls = [];
const stub = (name) => (req, res) => {
  calls.push(name);
  res.status(299).json({ handler: name });
};
jest.mock("../controllers/b2c.users.controller", () => ({
  handleMicrosoftRedirect: stub("b2c:redirect"),
  handleMicrosoftCallback: stub("b2c:callback"),
}));
jest.mock("../controllers/azure.ad.controller", () => ({
  handleAzureADRedirect: stub("aad:redirect"),
  handleAzureADCallback: stub("aad:callback"),
}));
jest.mock("../controllers/auth.controller", () => ({
  refreshToken: stub("refresh"),
  logout: stub("logout"),
  revokeToken: stub("revoke"),
  revokeAllTokens: stub("revokeAll"),
}));
jest.mock("../middlewares/auth", () => ({
  authenticate: (req, res, next) => (calls.push("authenticate"), next()),
}));

const authRouter = require("../routes/auth.routes");

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => (calls.length = 0));

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      `${base}${url}`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const routeTable = () =>
  authRouter.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

describe("auth.routes.js — general-crm removed (Phase 2B)", () => {
  test("A general-crm routes are not declared; the other auth routes are unchanged", () => {
    const table = routeTable();
    expect(table.filter((r) => r.includes("general-crm"))).toEqual([]);
    expect(table).toEqual([
      "GET /azure-crm",
      "POST /azure-crm",
      "GET /azure-portal",
      "POST /azure-portal",
      "POST /refresh",
      "POST /logout",
      "POST /revoke",
      "POST /revoke-all",
    ]);
  });

  test.each(["/auth/general-crm/register", "/auth/general-crm/login"])(
    "B POST %s returns 404 and reaches no handler (even with a body tenantId)",
    async (url) => {
      const res = await post(url, { email: "x@example.com", password: "p", tenantId: "tenant-B" });
      expect(res.status).toBe(404);
      expect(calls).toEqual([]);
      expect(res.raw).not.toMatch(/token/i);
    }
  );

  test("C the dead register/login code is gone (controller, handler, schema)", () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    expect(read("controllers/user.controller.js")).not.toMatch(/handleRegistration|handleLogin/);
    expect(read("handlers/user.handler.js")).not.toMatch(/handleNewUser|handleLogin|bcrypt/);
    expect(fs.existsSync(path.join(__dirname, "..", "validation", "crm.general.schema.js"))).toBe(false);
    expect(read("routes/auth.routes.js")).not.toMatch(/general-crm\/(register|login)"/);
  });
});
