/**
 * Rate limiting for the sign-in start (GET /pkce/generate: CRM organisation sign-in, the legacy
 * no-code CRM sign-in and the B2C member sign-in).
 *
 * Keyed ONLY by client IP - never by organisation code, tenant, directory, user or email, so nobody
 * can lock an organisation out by exhausting "its" bucket. It runs before the locator is resolved,
 * so valid, invalid, internal-id, malformed and no-code starts all count the same.
 *
 * Client IP: Express `trust proxy` stays OFF. The gateway overwrites X-Real-IP with the address it
 * saw ($remote_addr); that header is used ONLY when the direct TCP peer is the configured trusted
 * gateway (LOGIN_RATE_LIMIT_TRUSTED_PROXY, one IP - never a subnet: other containers on the Docker
 * network must not be able to pick a client's bucket). X-Forwarded-For is never read. A missing,
 * malformed or multi-valued X-Real-IP from the gateway falls back to the gateway's own address
 * (a stricter shared bucket, never a bypass); any other peer is keyed by its own address.
 *
 * Two windows per client IP, both must pass: 60 / minute (burst) and 300 / hour (sustained).
 * Limited -> 429 with a generic body and Retry-After; no organisation information.
 * Platform-wide volume is OBSERVED only (a structured warning when > LOGIN_RATE_GLOBAL_ALERT starts
 * within 10 minutes); it never blocks, so an attacker cannot deny sign-in to every customer.
 *
 * Store: in-memory, per process. Correct for the single DEV user-service instance; a distributed
 * store is required before running several replicas.
 */
const net = require("net");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const TRUSTED_PROXY_ENV = "LOGIN_RATE_LIMIT_TRUSTED_PROXY";
const GLOBAL_ALERT_ENV = "LOGIN_RATE_GLOBAL_ALERT";
const MESSAGE = "Too many sign-in attempts. Please wait and try again.";
const BURST = { windowMs: 60 * 1000, limit: 60 };
const SUSTAINED = { windowMs: 60 * 60 * 1000, limit: 300 };
const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_GLOBAL_ALERT = 2000;

class LoginRateLimitConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginRateLimitConfigError";
  }
}

/** Normalised IP string (IPv4-mapped IPv6 -> IPv4, IPv6 lower-cased), or null when not one IP. */
function normalizeIp(value) {
  if (typeof value !== "string") return null;
  let ip = value.trim();
  if (!ip || ip.includes(",") || /\s/.test(ip)) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (family === 4) return ip;
  if (family === 6) return ip.toLowerCase();
  return null;
}

/** The configured trusted gateway peer (normalised), or null when unset. Throws when malformed. */
function trustedProxy(env = process.env) {
  const raw = env[TRUSTED_PROXY_ENV];
  if (raw === undefined || String(raw).trim() === "") return null;
  const ip = normalizeIp(String(raw));
  if (!ip) throw new LoginRateLimitConfigError(`${TRUSTED_PROXY_ENV} must be exactly one IP address`);
  return ip;
}

function globalAlertThreshold(env = process.env) {
  const raw = env[GLOBAL_ALERT_ENV];
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_GLOBAL_ALERT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new LoginRateLimitConfigError(`${GLOBAL_ALERT_ENV} must be a positive integer`);
  return n;
}

/** Startup check (app.js): malformed configuration stops the service instead of being ignored. */
function assertLoginRateLimitConfig(env = process.env) {
  trustedProxy(env);
  globalAlertThreshold(env);
}

/**
 * The client address a sign-in start is counted against (see header comment). Pure: the request,
 * and the trusted gateway address (already normalised).
 */
function clientAddress(req, trusted) {
  const peer = normalizeIp(req.socket && req.socket.remoteAddress) || "unknown-peer";
  if (!trusted || peer !== trusted) return peer;
  const forwarded = req.headers ? req.headers["x-real-ip"] : undefined;
  if (Array.isArray(forwarded)) return peer; // repeated header -> not one value
  return normalizeIp(forwarded) || peer;
}

/** Limiter key: IPv4 as is; IPv6 grouped by network (express-rate-limit's ipKeyGenerator). */
const keyFor = (address) => (net.isIP(address) ? ipKeyGenerator(address) : address);

function createLoginStartRateLimit({ env = process.env, now = () => Date.now(), logger = console } = {}) {
  const trusted = trustedProxy(env);
  const alertAt = globalAlertThreshold(env);
  const keyGenerator = (req) => keyFor(clientAddress(req, trusted));
  const handler = (req, res, _next, options) => {
    res.status(options.statusCode).json({
      success: false,
      error: { message: MESSAGE, code: "RATE_LIMITED", status: options.statusCode },
    });
  };
  const common = {
    standardHeaders: "draft-6", // RateLimit-* and Retry-After
    legacyHeaders: false,
    keyGenerator,
    handler,
    // The key is derived above (peer-checked X-Real-IP); express-rate-limit's req.ip / trust-proxy /
    // X-Forwarded-For heuristics do not apply to it.
    validate: { trustProxy: false, xForwardedForHeader: false, ip: false, keyGeneratorIpFallback: false },
  };
  const burst = rateLimit({ ...common, ...BURST });
  const sustained = rateLimit({ ...common, ...SUSTAINED });

  // Platform-wide observation only (never blocks).
  let windowStart = now();
  let count = 0;
  let alerted = false;
  const observe = (req, res, next) => {
    const t = now();
    if (t - windowStart >= GLOBAL_WINDOW_MS) {
      windowStart = t;
      count = 0;
      alerted = false;
    }
    count += 1;
    if (!alerted && count > alertAt) {
      alerted = true;
      logger.warn(JSON.stringify({ event: "login_rate_global_threshold", window: "10m", count, threshold: alertAt }));
    }
    next();
  };

  // Named steps, so the route's middleware chain can be asserted exactly (tests/sessionsRemoval).
  observe.loginStartStep = "global-observe";
  burst.loginStartStep = "burst-60-per-minute";
  sustained.loginStartStep = "sustained-300-per-hour";
  return [observe, burst, sustained];
}

module.exports = {
  createLoginStartRateLimit,
  assertLoginRateLimitConfig,
  clientAddress,
  normalizeIp,
  trustedProxy,
  LoginRateLimitConfigError,
  MESSAGE,
  BURST,
  SUSTAINED,
  LOGIN_START_STEPS: ["global-observe", "burst-60-per-minute", "sustained-300-per-hour"],
};
