/**
 * Phase 1C-2Y — POST /sessions removed.
 *
 * The endpoint (B2C id_token -> internal JWT) never worked: createSession was registered unbound, so
 * every request with an id_token failed before token validation. It had no live caller, was not routed
 * by the gateway, and binding it would have added a second, weaker pre-auth login (tenant from token
 * claims, email-only identity across userTypes, no isActive / nonce checks) next to the hardened
 * /auth/azure-portal PKCE + nonce flow. These tests prove it is gone and the working login is untouched.
 *
 * Loads the REAL routes/index.js (no network calls are made by these requests).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");

const ROOT = path.join(__dirname, "..");
// Loading the full router starts background cache clients that keep logging (e.g. Redis reconnects);
// silence the console for the whole file so nothing logs after the tests finish.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
console.info = () => {};

let server;
let port;
let index;
beforeAll(async () => {
  index = require("../routes/index");
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/", index);
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));

const request = (method, p, body) => new Promise((resolve) => {
  const d = body === undefined ? "" : JSON.stringify(body);
  const headers = { "content-type": "application/json" };
  if (d) headers["content-length"] = Buffer.byteLength(d);
  const rq = http.request({ port, path: p, method, headers, timeout: 5000 }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
  });
  rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE" }); });
  rq.end(d || undefined);
});

describe("POST /sessions is gone", () => {
  test.each([[{}], [{ id_token: "a.b.c" }]])("POST /sessions %j -> 404 through the real top-level router", async (body) => {
    const r = await request("POST", "/sessions", body);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ notFound: true });
  });
  test("route and controller files are deleted; index.js mounts nothing at /sessions", () => {
    expect(fs.existsSync(path.join(ROOT, "routes", "sessions.routes.js"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "controllers", "sessions.controller.js"))).toBe(false);
    const src = fs.readFileSync(path.join(ROOT, "routes", "index.js"), "utf8");
    expect(src).not.toMatch(/router\.use\(\s*["']\/sessions["']/);
    // (the root "/" mount matches every path, so check the mount patterns themselves)
    expect(index.stack.filter((l) => !l.route).some((l) => l.regexp.source.includes("sessions"))).toBe(false);
  });
});

describe("working member-portal login is structurally unchanged", () => {
  test("/auth/azure-portal GET/POST still map to the b2c.users controller handlers", () => {
    const auth = require("../routes/auth.routes");
    const b2c = require("../controllers/b2c.users.controller");
    const routes = auth.stack.filter((l) => l.route && l.route.path === "/azure-portal");
    expect(routes.map((l) => Object.keys(l.route.methods)[0]).sort()).toEqual(["get", "post"]);
    const byMethod = Object.fromEntries(routes.map((l) => [Object.keys(l.route.methods)[0], l.route.stack.map((x) => x.handle)]));
    expect(byMethod.get).toEqual([b2c.handleMicrosoftRedirect]);
    expect(byMethod.post).toEqual([b2c.handleMicrosoftCallback]);
  });
  test("/pkce/generate still served by pkce.controller.generatePKCE", () => {
    const pkce = require("../routes/pkce.routes");
    const ctl = require("../controllers/pkce.controller");
    const gen = pkce.stack.find((l) => l.route && l.route.path === "/generate" && l.route.methods.get);
    expect(gen.route.stack.map((x) => x.handle)).toEqual([ctl.generatePKCE]);
  });
  test("/auth, /token, /pkce, /policy mounts remain", () => {
    for (const p of ["/auth", "/token", "/pkce", "/policy"]) {
      expect(index.stack.filter((l) => !l.route).some((l) => l.regexp.test(p))).toBe(true);
    }
  });
  test("B2C validation keeps RS256 pin, nonce check and the fixed trusted directory id", () => {
    const h = fs.readFileSync(path.join(ROOT, "handlers", "b2c.users.handler.js"), "utf8");
    expect(h).toMatch(/algorithms:\s*\["RS256"\]/);
    expect(h).toMatch(/payload\.nonce !== expectedNonce/);
    expect(h).toMatch(/const extractedDirectoryId = process\.env\.MS_B2C_DIRECTORY_ID;/);
  });
});
