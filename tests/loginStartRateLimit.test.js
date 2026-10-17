/**
 * Sign-in start rate limit (GET /pkce/generate): peer-checked X-Real-IP client key, 60 / minute and
 * 300 / hour per client IP, generic 429 + Retry-After, log-only platform-wide threshold, startup
 * configuration validation. The real routes/pkce.routes.js is exercised with a stub controller.
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");

const mockGenerate = jest.fn((req, res) => res.status(200).json({ success: true, tenant: req.query.tenant || null }));
const mockLogoutUrls = jest.fn((req, res) => res.status(200).json({ success: true }));
jest.mock("../controllers/pkce.controller", () => ({
  generatePKCE: (...a) => mockGenerate(...a),
  getLogoutUrls: (...a) => mockLogoutUrls(...a),
}));

const {
  createLoginStartRateLimit,
  assertLoginRateLimitConfig,
  clientAddress,
  normalizeIp,
  LoginRateLimitConfigError,
  MESSAGE,
} = require("../middlewares/loginStartRateLimit");

const GATEWAY = "172.18.0.14";
const reqOf = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

// supertest connects from loopback, so loopback plays the trusted gateway in the HTTP tests
const LOOPBACK = "127.0.0.1";
let clock;
const advance = (ms) => {
  clock += ms;
  jest.setSystemTime(clock);
};
let warn;
let app;
const servers = [];
async function appWith(env = { LOGIN_RATE_LIMIT_TRUSTED_PROXY: LOOPBACK }) {
  let router;
  const saved = process.env.LOGIN_RATE_LIMIT_TRUSTED_PROXY;
  jest.isolateModules(() => {
    if (env.LOGIN_RATE_LIMIT_TRUSTED_PROXY === undefined) delete process.env.LOGIN_RATE_LIMIT_TRUSTED_PROXY;
    else process.env.LOGIN_RATE_LIMIT_TRUSTED_PROXY = env.LOGIN_RATE_LIMIT_TRUSTED_PROXY;
    router = require("../routes/pkce.routes");
  });
  if (saved === undefined) delete process.env.LOGIN_RATE_LIMIT_TRUSTED_PROXY;
  else process.env.LOGIN_RATE_LIMIT_TRUSTED_PROXY = saved;
  const a = express();
  a.use("/pkce", router);
  // one server per app, bound to IPv4 loopback: the peer is always 127.0.0.1, and requests cannot
  // land on another local process sharing the ephemeral port (supertest's default listens on ::)
  const server = a.listen(0, LOOPBACK);
  servers.push(server);
  await new Promise((r) => server.once("listening", r)); // else supertest starts (and closes) its own
  return server;
}
const start = (client, query = "") => {
  const r = request(app).get(`/pkce/generate${query}`);
  return client ? r.set("X-Real-IP", client) : r;
};
async function send(n, client, query) {
  const statuses = [];
  for (let i = 0; i < n; i++) statuses.push((await start(client, query)).status);
  return statuses;
}

beforeEach(async () => {
  jest.clearAllMocks();
  // Fake ONLY the system clock (Date.now and new Date(), both used by express-rate-limit's
  // MemoryStore); real timers keep supertest working. advance() moves the clock.
  clock = Date.parse("2026-10-17T10:00:00Z");
  jest.useFakeTimers({
    doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "hrtime", "performance"],
  });
  jest.setSystemTime(clock);
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  app = await appWith();
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("client IP trust", () => {
  test("1 trusted gateway peer + one valid X-Real-IP -> that client IP", () => {
    expect(clientAddress(reqOf(GATEWAY, { "x-real-ip": "203.0.113.7" }), GATEWAY)).toBe("203.0.113.7");
  });

  test("2 untrusted peer: a forged X-Real-IP is ignored (keyed by the peer)", () => {
    expect(clientAddress(reqOf("172.18.0.20", { "x-real-ip": "203.0.113.7" }), GATEWAY)).toBe("172.18.0.20");
    expect(clientAddress(reqOf("198.51.100.9", { "x-real-ip": "203.0.113.7" }), GATEWAY)).toBe("198.51.100.9");
  });

  test("3 X-Forwarded-For is never read (trusted or untrusted peer)", () => {
    expect(clientAddress(reqOf(GATEWAY, { "x-forwarded-for": "203.0.113.7" }), GATEWAY)).toBe(GATEWAY);
    expect(clientAddress(reqOf("172.18.0.20", { "x-forwarded-for": "203.0.113.7" }), GATEWAY)).toBe("172.18.0.20");
  });

  test("4 malformed / comma-separated / repeated / unexpected X-Real-IP from the gateway -> gateway peer bucket", () => {
    for (const bad of ["not-an-ip", "203.0.113.7, 198.51.100.1", "203.0.113.7 198.51.100.1", "203.0.113.999", "", "unknown", ["203.0.113.7", "198.51.100.1"]]) {
      expect(clientAddress(reqOf(GATEWAY, { "x-real-ip": bad }), GATEWAY)).toBe(GATEWAY);
    }
  });

  test("5 missing X-Real-IP from the gateway -> gateway peer bucket; no trusted gateway configured -> peer", () => {
    expect(clientAddress(reqOf(GATEWAY), GATEWAY)).toBe(GATEWAY);
    expect(clientAddress(reqOf(GATEWAY, { "x-real-ip": "203.0.113.7" }), null)).toBe(GATEWAY);
  });

  test("6 IPv4-mapped gateway peer is recognised; IPv6 normalised; the Docker subnet is not trusted", () => {
    expect(clientAddress(reqOf(`::ffff:${GATEWAY}`, { "x-real-ip": "203.0.113.7" }), GATEWAY)).toBe("203.0.113.7");
    expect(clientAddress(reqOf(GATEWAY, { "x-real-ip": "2001:DB8::1" }), GATEWAY)).toBe("2001:db8::1");
    expect(clientAddress(reqOf(GATEWAY, { "x-real-ip": "::ffff:203.0.113.7" }), GATEWAY)).toBe("203.0.113.7");
    expect(clientAddress(reqOf("172.18.0.15", { "x-real-ip": "203.0.113.7" }), GATEWAY)).toBe("172.18.0.15");
    expect(normalizeIp("::ffff:172.18.0.14")).toBe(GATEWAY);
    expect(normalizeIp("2001:db8::/32")).toBeNull();
  });

  test("7 two browser IPs behind the gateway get separate buckets", async () => {
    expect((await send(60, "203.0.113.1")).every((s) => s === 200)).toBe(true);
    expect((await start("203.0.113.1")).status).toBe(429);
    expect((await start("203.0.113.2")).status).toBe(200);
  });

  test("8 the same IP shares one bucket for valid and invalid organisation codes", async () => {
    await send(30, "203.0.113.3", "?tenant=MULTIAUTH");
    await send(30, "203.0.113.3", "?tenant=NO-SUCH-ORG");
    expect((await start("203.0.113.3", "?tenant=DEVTENANTB")).status).toBe(429);
  });
});

describe("limits", () => {
  test("9 normal CRM organisation start and B2C / no-code start pass through to the controller", async () => {
    expect((await start("203.0.113.10", "?tenant=MULTIAUTH")).status).toBe(200);
    expect((await start("203.0.113.10")).status).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  test("10/11 50 per minute allowed; 60 allowed; request 61 -> 429", async () => {
    expect((await send(50, "203.0.113.11")).every((s) => s === 200)).toBe(true);
    expect((await send(10, "203.0.113.11")).every((s) => s === 200)).toBe(true);
    expect((await start("203.0.113.11")).status).toBe(429);
    expect(mockGenerate).toHaveBeenCalledTimes(60);
  });

  test("12 the minute window resets", async () => {
    await send(61, "203.0.113.12");
    advance(61 * 1000);
    expect((await start("203.0.113.12")).status).toBe(200);
  });

  test("13 300 per hour: within the hour, request 301 -> 429 even though each minute is under 60", async () => {
    for (let m = 0; m < 5; m++) {
      expect((await send(60, "203.0.113.13")).every((s) => s === 200)).toBe(true);
      advance(61 * 1000);
    }
    expect((await start("203.0.113.13")).status).toBe(429);
    advance(60 * 60 * 1000);
    expect((await start("203.0.113.13")).status).toBe(200);
  });

  test("14 another IP is unaffected by a limited IP", async () => {
    await send(61, "203.0.113.14");
    expect((await start("198.51.100.14")).status).toBe(200);
  });

  test("15 valid, invalid, internal-id, malformed and no-code starts count identically", async () => {
    for (const q of ["?tenant=MULTIAUTH", "?tenant=NO-SUCH-ORG", "?tenant=68cbf7806080b4621d469d34", "?tenant=%7B%24ne%3A1%7D", ""]) {
      await send(12, "203.0.113.15", q);
    }
    expect((await start("203.0.113.15", "?tenant=MULTIAUTH")).status).toBe(429);
  });

  test("16 the 429 body is generic: no organisation, tenant or IP information", async () => {
    await send(60, "203.0.113.16", "?tenant=MULTIAUTH");
    const r = await start("203.0.113.16", "?tenant=MULTIAUTH");
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ success: false, error: { message: MESSAGE, code: "RATE_LIMITED", status: 429 } });
    expect(MESSAGE).toBe("Too many sign-in attempts. Please wait and try again.");
    expect(JSON.stringify(r.body)).not.toMatch(/MULTIAUTH|203\.0\.113|tenant/i);
  });

  test("17 Retry-After is sent with the 429", async () => {
    await send(60, "203.0.113.17");
    const r = await start("203.0.113.17");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(r.headers["retry-after"])).toBeLessThanOrEqual(60);
  });

  test("18 a limited start never reaches the controller (no locator resolution, no Microsoft redirect)", async () => {
    await send(60, "203.0.113.18");
    mockGenerate.mockClear();
    await start("203.0.113.18", "?tenant=MULTIAUTH");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("19 the limiter runs before generatePKCE; only /pkce/generate is limited (logout-urls unaffected)", async () => {
    const router = require("../routes/pkce.routes");
    const gen = router.stack.find((l) => l.route && l.route.path === "/generate");
    expect(gen.route.stack).toHaveLength(4); // observe, burst, sustained, controller
    await send(61, "203.0.113.19");
    expect((await request(app).get("/pkce/logout-urls").set("X-Real-IP", "203.0.113.19")).status).toBe(200);
  });

  test("20 callbacks, Entra Connect and tenant APIs do not use the limiter", () => {
    const routesDir = path.join(__dirname, "..", "routes");
    const users = fs.readdirSync(routesDir).filter((f) => fs.readFileSync(path.join(routesDir, f), "utf8").includes("loginStartRateLimit"));
    expect(users).toEqual(["pkce.routes.js"]);
  });

  test("21 platform-wide threshold logs once per 10 minutes and never blocks", async () => {
    const logger = { warn: jest.fn() };
    const [observe] = createLoginStartRateLimit({ env: { LOGIN_RATE_GLOBAL_ALERT: "3" }, now: () => clock, logger });
    const next = jest.fn();
    for (let i = 0; i < 5; i++) observe({}, {}, next);
    expect(next).toHaveBeenCalledTimes(5);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.warn.mock.calls[0][0])).toEqual({ event: "login_rate_global_threshold", window: "10m", count: 4, threshold: 3 });
    advance(10 * 60 * 1000);
    for (let i = 0; i < 4; i++) observe({}, {}, next);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test("22 configuration: valid IPs accepted; malformed values stop startup; default threshold 2000", () => {
    expect(() => assertLoginRateLimitConfig({})).not.toThrow();
    expect(() => assertLoginRateLimitConfig({ LOGIN_RATE_LIMIT_TRUSTED_PROXY: GATEWAY })).not.toThrow();
    expect(() => assertLoginRateLimitConfig({ LOGIN_RATE_LIMIT_TRUSTED_PROXY: `::ffff:${GATEWAY}` })).not.toThrow();
    for (const bad of ["172.18.0.0/16", "172.18.0.14,172.18.0.15", "gateway", "172.18.0.256"]) {
      expect(() => assertLoginRateLimitConfig({ LOGIN_RATE_LIMIT_TRUSTED_PROXY: bad })).toThrow(LoginRateLimitConfigError);
    }
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(() => assertLoginRateLimitConfig({ LOGIN_RATE_GLOBAL_ALERT: bad })).toThrow(LoginRateLimitConfigError);
    }
    const logger = { warn: jest.fn() };
    const [observe] = createLoginStartRateLimit({ env: {}, now: () => clock, logger });
    for (let i = 0; i < 2001; i++) observe({}, {}, () => {});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.warn.mock.calls[0][0]).count).toBe(2001);
  });

  test("direct (non-gateway) traffic cannot choose a bucket with X-Real-IP", async () => {
    app = await appWith({ LOGIN_RATE_LIMIT_TRUSTED_PROXY: GATEWAY }); // loopback peer is NOT the gateway
    expect((await send(60, "203.0.113.30")).every((s) => s === 200)).toBe(true);
    expect((await start("203.0.113.31")).status).toBe(429); // same peer bucket despite a new header value
  });

  test("the limiter produces no express-rate-limit validation warnings", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    app = await appWith();
    await send(2, "203.0.113.40");
    expect([...warn.mock.calls, ...error.mock.calls].flat().map(String).join(" ")).not.toMatch(/ERR_ERL|express-rate-limit/);
  });
});
