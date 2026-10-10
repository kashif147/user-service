/**
 * Phase 1C-2S — error responses expose diagnostics (stack / extras / raw error text) ONLY when
 * NODE_ENV === "development".
 *
 * Before, both shared error layers used `NODE_ENV !== "production"`, so staging (DEV runs
 * NODE_ENV=staging), test and an unset NODE_ENV returned stack traces with file paths, error extras,
 * and — for non-AppError failures — the raw error message (e.g. Redis host/port).
 *
 * Covers both layers:
 *  - middlewares/response.mw.js sendAppError (all res.send* helpers);
 *  - the final error handler in app.js. app.js cannot be required in a unit test (it opens DB/Redis
 *    and mounts every router), so the handler is taken VERBATIM from app.js source and evaluated with
 *    the same free variables app.js gives it (crypto, responseMiddleware).
 * Server-side logging of the full error is unchanged and asserted here too.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { AppError } = require("../errors/AppError");
const responseMiddleware = require("../middlewares/response.mw");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = appSrc.indexOf("app.use((err, req, res, next) => {");
const end = appSrc.indexOf("\n});\n", start) + 4;
const handlerSrc = appSrc.slice(start + "app.use(".length, end - 1).trim().replace(/\)$/, "");
// eslint-disable-next-line no-new-func
const finalHandler = new Function("crypto", "responseMiddleware", `return (${handlerSrc});`)(crypto, responseMiddleware);

const PATH_MARKER = "/srv/secret/PATH_MARKER/db.js";
const RAW = `ECONNREFUSED redis://secret-host:6379 at ${PATH_MARKER}`;

let server;
let port;
const ORIGINAL_ENV = process.env.NODE_ENV;
beforeAll(async () => {
  const app = express();
  app.use(responseMiddleware);
  app.get("/helper500", (req, res) => res.sendInternalError("Failed to do X", { extras: { secret: "EXTRAS_MARKER" } }));
  app.get("/helper400", (req, res) => res.sendBadRequest("Bad input"));
  app.get("/helper401", (req, res) => res.sendUnauthorized("Who are you"));
  app.get("/helper403", (req, res) => res.sendForbidden("Not allowed"));
  app.get("/helper404", (req, res) => res.sendNotFound("Missing"));
  app.get("/helper409", (req, res) => res.sendConflict("Clash"));
  app.get("/next-apperror", (req, res, next) => next(AppError.badRequest("Bad input via next", { extras: { secret: "EXTRAS_MARKER" } })));
  app.get("/next-raw", (req, res, next) => {
    const e = new Error(RAW);
    e.stack = `Error: boom\n    at connect (${PATH_MARKER}:12:3)`;
    next(e);
  });
  app.get("/ok", (req, res) => res.success({ fine: true }));
  app.use(finalHandler);
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
  return new Promise((r) => server.close(r));
});
let logSpy;
beforeEach(() => { logSpy = jest.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { logSpy.mockRestore(); process.env.NODE_ENV = ORIGINAL_ENV; });

const setEnv = (env) => { if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env; };
const get = (p) => new Promise((resolve) => {
  http.get({ port, path: p, headers: { "x-correlation-id": "cid-1" } }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, raw: b, body: JSON.parse(b) }));
  });
});

const ERROR_ROUTES = [
  ["/helper500", 500, "Failed to do X", "INTERNAL_SERVER_ERROR"],
  ["/helper400", 400, "Bad input", "BAD_REQUEST"],
  ["/helper401", 401, "Who are you", "UNAUTHORIZED"],
  ["/helper403", 403, "Not allowed", "FORBIDDEN"],
  ["/helper404", 404, "Missing", "NOT_FOUND"],
  ["/helper409", 409, "Clash", "CONFLICT"],
  ["/next-apperror", 400, "Bad input via next", "BAD_REQUEST"],
];

describe.each([["staging"], ["production"], ["test"], [undefined]])("NODE_ENV=%s: safe responses", (env) => {
  test.each(ERROR_ROUTES)("%s -> %i, same message/code/envelope, no stack/extras/paths", async (p, status, message, code) => {
    setEnv(env);
    const r = await get(p);
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ success: false, error: { message, code, status }, correlationId: "cid-1" });
    expect(r.raw).not.toMatch(/EXTRAS_MARKER|PATH_MARKER|node_modules|\.js:\d+/);
  });

  test("unexpected (non-AppError) failure -> generic 500, no raw error text, no stack", async () => {
    setEnv(env);
    const r = await get("/next-raw");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ success: false, error: { message: "Internal Server Error", code: "INTERNAL_SERVER_ERROR", status: 500 }, correlationId: "cid-1" });
    expect(r.raw).not.toMatch(/secret-host|ECONNREFUSED|PATH_MARKER/);
  });
});

describe("NODE_ENV=development: diagnostics kept (unchanged behaviour)", () => {
  test("helpers and next(AppError) include stack (and extras when given)", async () => {
    setEnv("development");
    const h = await get("/helper500");
    expect(h.status).toBe(500);
    expect(h.body.error.message).toBe("Failed to do X");
    expect(typeof h.body.error.stack).toBe("string");
    expect(h.body.error.extras).toEqual({ secret: "EXTRAS_MARKER" });
    const n = await get("/next-apperror");
    expect(n.status).toBe(400);
    expect(typeof n.body.error.stack).toBe("string");
  });
  test("unexpected failure returns the raw message and stack", async () => {
    setEnv("development");
    const r = await get("/next-raw");
    expect(r.status).toBe(500);
    expect(r.body.error.message).toBe(RAW);
    expect(r.body.error.stack).toContain(PATH_MARKER);
  });
});

test("success responses are unchanged", async () => {
  for (const env of ["development", "staging", "production", "test"]) {
    setEnv(env);
    const r = await get("/ok");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "success", data: { fine: true } });
  }
});

test("server-side logging of unexpected errors is unchanged (staging still logs message and stack)", async () => {
  setEnv("staging");
  await get("/next-raw");
  const lines = logSpy.mock.calls.map((c) => c.join(" "));
  expect(lines).toContain(`ERROR: ${RAW}`);
  expect(lines.some((l) => l.startsWith("STACK:") && l.includes(PATH_MARKER))).toBe(true);
});

test("policy is an explicit allow-list: only 'development' exposes diagnostics", () => {
  const seen = {};
  for (const env of ["development", "dev", "local", "staging", "production", "test", "", undefined]) {
    setEnv(env);
    seen[String(env)] = responseMiddleware.exposeErrorDiagnostics();
  }
  expect(Object.entries(seen).filter(([, v]) => v).map(([k]) => k)).toEqual(["development"]);
});
