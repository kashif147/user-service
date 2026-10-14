/**
 * General request log - allow-list only.
 *
 * One line per request, written when the response ends, with safe metadata only: method, route,
 * status, duration, correlation id and the internal userId / tenantId once authentication has
 * set them. Request bodies, query strings, headers (Authorization, cookies) and anything derived
 * from them are never logged: they carry OAuth codes, PKCE verifiers, state, tokens and personal
 * data. A new field is only logged by adding it here explicitly.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A path segment is logged as-is only when it looks like a plain identifier.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

const safeId = (value) => (typeof value === "string" && SAFE_ID.test(value) ? value : undefined);

const redactPath = (path) =>
  path
    .split("/")
    .map((segment) => (segment === "" || SAFE_SEGMENT.test(segment) ? segment : ":redacted"))
    .join("/");

// The matched route template (e.g. /api/users/:id) when Express matched one; otherwise the path
// without its query string, with any segment that is not a plain identifier replaced.
// req.baseUrl cannot be used: Express resets it when a request leaves its router through
// next(err), so the mount prefix is taken from the request path instead - the route template
// matched the trailing segments, everything before them is the (redacted) mount path.
function routeOf(req) {
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  const template = req.route && req.route.path;
  if (typeof template === "string" && !/[*?()+]/.test(template)) {
    const trim = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
    const pathSegments = trim(path).split("/");
    const templateSegments = trim(template).split("/").filter(Boolean);
    const prefix = pathSegments.slice(0, pathSegments.length - templateSegments.length).join("/");
    return `${redactPath(prefix)}${template === "/" && prefix ? "" : template}`;
  }
  return redactPath(path);
}

function requestLogEntry(req, res, durationMs) {
  const entry = {
    method: req.method,
    route: routeOf(req),
    status: res.headersSent ? res.statusCode : 0,
    durationMs,
  };
  const correlationId = safeId(req.correlationId);
  const userId = safeId(String(req.ctx?.userId ?? req.userId ?? ""));
  const tenantId = safeId(String(req.ctx?.tenantId ?? req.tenantId ?? ""));
  if (correlationId) entry.correlationId = correlationId;
  if (userId) entry.userId = userId;
  if (tenantId) entry.tenantId = tenantId;
  if (!res.writableFinished) entry.outcome = "aborted";
  return entry;
}

const loggerMiddleware = (req, res, next) => {
  // Skip logging for health check endpoints
  if (req.path === "/health" || req.path.startsWith("/health/")) {
    return next();
  }

  const start = process.hrtime.bigint();
  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    const durationMs = Number((process.hrtime.bigint() - start) / 1000000n);
    console.log("HTTP request", requestLogEntry(req, res, durationMs));
  };
  res.on("finish", log);
  res.on("close", log);
  next();
};

module.exports = loggerMiddleware;
module.exports.requestLogEntry = requestLogEntry;
