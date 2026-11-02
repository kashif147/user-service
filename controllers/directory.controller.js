/**
 * P5 CRM user directory (directory:read). Tenant ONLY from req.verifiedCaller (set by
 * middlewares/requireVerifiedUserToken.js from the cryptographically verified user JWT), never
 * from forwarded x-tenant-id / x-user-* headers or req.ctx. Responses: data = [{ id, displayName }].
 */
const DirectoryHandler = require("../handlers/directory.handler");
const { isPlatformNamespace } = require("../constants/permissionClassification");
const { AppError } = require("../errors/AppError");

/**
 * Route guard after requireVerifiedUserToken: the VERIFIED token's userType must be exactly "CRM".
 * Needed in addition to the PDP: the PDP's ASU own-tenant rule permits before its category check,
 * so a PORTAL / typeless token carrying ASU (or a forged permission list) must still be refused here.
 */
function requireVerifiedCrmCaller(req, res, next) {
  if (req.verifiedCaller?.userType !== "CRM") {
    return res.status(403).json({
      error: { message: "Permission denied", code: "CRM_CALLER_REQUIRED", status: 403 },
    });
  }
  return next();
}

/** POST /api/directory/users/lookup  body: { ids: string[] } (max 500; non-ObjectId entries ignored). */
async function lookupDirectoryUsers(req, res, next) {
  try {
    const tenantId = req.verifiedCaller?.tenantId;
    if (!tenantId) return next(AppError.forbidden("Verified tenant context required"));
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) return next(AppError.badRequest("ids array is required"));
    if (ids.length > DirectoryHandler.DIRECTORY_LOOKUP_MAX_IDS) {
      return next(AppError.badRequest(`Too many ids (max ${DirectoryHandler.DIRECTORY_LOOKUP_MAX_IDS} per request)`));
    }
    const data = await DirectoryHandler.lookupDisplayNames(ids, tenantId);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    console.error("[directory] lookup failed", { name: error?.name });
    return next(AppError.internalServerError("Failed to look up users"));
  }
}

/** Parse ?permission=resource:action; returns { resource, action } | null (absent) | false (invalid). */
function parsePermission(raw) {
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 128) return false;
  const canonical = raw.trim().toLowerCase();
  if (!DirectoryHandler.PERMISSION_FORMAT.test(canonical)) return false;
  if (isPlatformNamespace(canonical)) return false;
  const [resource, action] = canonical.split(":");
  return { resource, action };
}

/** GET /api/directory/users?q=<name prefix>&permission=<resource:action>&limit=<1..50, default 20> */
async function listDirectoryUsers(req, res, next) {
  try {
    const tenantId = req.verifiedCaller?.tenantId;
    if (!tenantId) return next(AppError.forbidden("Verified tenant context required"));
    const { q, permission, limit } = req.query || {};

    if (q !== undefined && typeof q !== "string") return next(AppError.badRequest("Invalid q"));
    const prefix = typeof q === "string" ? q.trim() : "";
    if (prefix.length > DirectoryHandler.DIRECTORY_QUERY_MAX_LENGTH) {
      return next(AppError.badRequest(`q too long (max ${DirectoryHandler.DIRECTORY_QUERY_MAX_LENGTH})`));
    }
    if (limit !== undefined && typeof limit !== "string") return next(AppError.badRequest("Invalid limit"));
    const perm = parsePermission(permission);
    if (perm === false) return next(AppError.badRequest("Invalid permission"));

    const data = await DirectoryHandler.listDirectoryUsers({
      tenantId,
      q: prefix || null,
      permission: perm,
      limit,
    });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    console.error("[directory] list failed", { name: error?.name });
    return next(AppError.internalServerError("Failed to list users"));
  }
}

module.exports = { requireVerifiedCrmCaller, lookupDirectoryUsers, listDirectoryUsers, parsePermission };
