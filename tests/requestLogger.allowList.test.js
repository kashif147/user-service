/**
 * The general request logger (middlewares/logger.mw.js) logs safe metadata only: method, route,
 * status, duration, correlation id and the internal userId / tenantId. Request bodies, query
 * values, headers and path values that are not plain identifiers never reach the logs.
 */
const express = require("express");
const request = require("supertest");
const loggerMiddleware = require("../middlewares/logger.mw");

const SECRETS = {
  code: "SECRET-OAUTH-CODE-0123456789",
  codeVerifier: "SECRET-PKCE-VERIFIER-0123456789",
  state: "SECRET-STATE-0123456789",
  token: "eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQtand0LXBheWxvYWQiOnRydWV9.SECRET-JWT-SIG",
  accessToken: "SECRET-ACCESS-TOKEN-0123456789",
  refreshToken: "SECRET-REFRESH-TOKEN-0123456789",
  idToken: "SECRET-ID-TOKEN-0123456789",
  email: "secret.person@example.org",
  password: "SECRET-PASSWORD-0123456789",
  client_secret: "SECRET-CLIENT-SECRET-0123456789",
};
const AUTHORIZATION = "Bearer SECRET-AUTHORIZATION-HEADER-0123456789";
const COOKIE = "connect.sid=SECRET-COOKIE-0123456789";
const SECRET_VALUES = [...Object.values(SECRETS), AUTHORIZATION, COOKIE, "SECRET-"];

const USER_ID = "6ab8f345e23ad3e2c9be4e4e";
const TENANT_ID = "68cbf7806080b4621d469d34";
const CORRELATION_ID = "0b6f1c1e-6a39-4f0c-9d0e-2f5f2f0a9a11";

function buildApp() {
  const app = express();
  app.use((req, res, next) => {
    req.correlationId = CORRELATION_ID;
    next();
  });
  app.use(express.json());
  app.use(loggerMiddleware);
  // Stands in for authentication, which sets the internal ids after the logger has run.
  const authenticated = (req, res, next) => {
    req.ctx = { userId: USER_ID, tenantId: TENANT_ID };
    next();
  };
  app.post("/auth/:provider", (req, res) => res.status(200).json({ ok: true }));
  app.put("/api/tenants/:id", authenticated, (req, res) => res.status(400).json({ ok: false }));
  app.post("/policy/evaluate", (req, res) => res.status(200).json({ decision: "PERMIT" }));
  app.get("/health", (req, res) => res.status(200).json({ status: "UP" }));
  return app;
}

const logged = () =>
  console.log.mock.calls
    .map((args) => args.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "))
    .join("\n");
const entries = () => console.log.mock.calls.filter((args) => args[0] === "HTTP request").map((args) => args[1]);
const expectNoSecrets = () => {
  const text = logged();
  for (const value of SECRET_VALUES) expect(text).not.toContain(value);
  expect(text).not.toMatch(/codeVerifier|refreshToken|client_secret|password|authorization|cookie/i);
};

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("request logger: no request data in logs", () => {
  test("POST with sensitive body fields, Authorization, cookie and secret query values", async () => {
    await request(buildApp())
      .post(`/auth/azure-crm?code=${SECRETS.code}&state=${SECRETS.state}`)
      .set("Authorization", AUTHORIZATION)
      .set("Cookie", COOKIE)
      .send(SECRETS)
      .expect(200);
    expectNoSecrets();
    expect(entries()).toHaveLength(1);
  });

  test("PUT with sensitive body fields (nested too) and Authorization", async () => {
    await request(buildApp())
      .put(`/api/tenants/${TENANT_ID}`)
      .set("Authorization", AUTHORIZATION)
      .send({ ...SECRETS, nested: { ...SECRETS }, list: [SECRETS] })
      .expect(400);
    expectNoSecrets();
    expect(entries()).toHaveLength(1);
  });

  test("a policy evaluation body carrying a ProjectShell JWT is not logged", async () => {
    await request(buildApp())
      .post("/policy/evaluate")
      .send({ token: SECRETS.token, resource: "portal", action: "read", context: { email: SECRETS.email } })
      .expect(200);
    expectNoSecrets();
  });

  test("an unmatched path keeps plain segments and redacts the rest", async () => {
    await request(buildApp())
      .get(`/api/users/email/${SECRETS.email}/${SECRETS.token}?code=${SECRETS.code}`)
      .expect(404);
    expectNoSecrets();
    expect(entries()[0].route).toBe("/api/users/email/:redacted/:redacted");
  });
});

describe("request logger: safe metadata is still logged", () => {
  test("method, route template, status, duration and correlation id", async () => {
    await request(buildApp()).post("/auth/azure-portal").send(SECRETS).expect(200);
    const [entry] = entries();
    expect(entry).toEqual({
      method: "POST",
      route: "/auth/:provider",
      status: 200,
      durationMs: expect.any(Number),
      correlationId: CORRELATION_ID,
    });
  });

  test("internal userId and tenantId once authentication has set them", async () => {
    await request(buildApp()).put(`/api/tenants/${TENANT_ID}`).send({ name: "x" }).expect(400);
    const [entry] = entries();
    expect(entry).toMatchObject({
      method: "PUT",
      route: "/api/tenants/:id",
      status: 400,
      correlationId: CORRELATION_ID,
      userId: USER_ID,
      tenantId: TENANT_ID,
    });
  });

  test("values that are not plain identifiers are left out, not logged", () => {
    const { requestLogEntry } = loggerMiddleware;
    const entry = requestLogEntry(
      {
        method: "GET",
        originalUrl: "/api/me",
        correlationId: "id with spaces",
        ctx: { userId: SECRETS.email, tenantId: TENANT_ID },
      },
      { headersSent: true, statusCode: 200, writableFinished: true },
      5,
    );
    expect(entry).toEqual({ method: "GET", route: "/api/me", status: 200, durationMs: 5, tenantId: TENANT_ID });
  });

  test("the mount prefix is kept when a mounted router's handler fails through next(err)", async () => {
    const app = express();
    app.use(loggerMiddleware);
    const pkce = express.Router();
    pkce.get("/generate", (req, res, next) => next(new Error("refused")));
    const tenants = express.Router();
    tenants.get("/tenants/:id", (req, res, next) => next(new Error("boom")));
    tenants.get("/", (req, res) => res.status(204).end());
    app.use("/pkce", pkce);
    app.use("/api", tenants);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(err.message === "refused" ? 400 : 500).end());

    await request(app).get(`/pkce/generate?tenant=${SECRETS.code}`).expect(400);
    await request(app).get(`/api/tenants/${TENANT_ID}?state=${SECRETS.state}`).expect(500);
    await request(app).get("/api/").expect(204);
    expect(entries().map((e) => [e.route, e.status])).toEqual([
      ["/pkce/generate", 400],
      ["/api/tenants/:id", 500],
      ["/api", 204],
    ]);
    expectNoSecrets();
  });

  test("health checks are not logged", async () => {
    await request(buildApp()).get("/health").expect(200);
    expect(entries()).toHaveLength(0);
  });
});
