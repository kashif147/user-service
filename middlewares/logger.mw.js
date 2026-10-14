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

// The matched route template (e.g. /api/users/:id) when Express matched one; otherwise the path
// without its query string, with any segment that is not a plain identifier replaced.
function routeOf(req) {
  if (req.route && typeof req.route.path === "string") {
    return `${req.baseUrl || ""}${req.route.path}`;
  }
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return path
    .split("/")
    .map((segment) => (segment === "" || SAFE_SEGMENT.test(segment) ? segment : ":redacted"))
    .join("/");
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
