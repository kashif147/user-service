/**
 * PDP rollout P2: CRM-only guard for staff reference-data reads (contacts / contact types).
 *
 * Mounted AFTER defaultPolicyAdapter.middleware(...), which sets req.user from the verified PDP decision
 * (or the decoded token on the dev-only bypass path). Anything but userType CRM - PORTAL, SYSTEM, or a
 * missing type - is refused; the PDP has already enforced the caller's own tenant and contact:read.
 */
function requireCrmUser(req, res, next) {
  if (req.user && req.user.userType === "CRM") return next();
  return res.status(403).json({
    success: false,
    error: { code: "CRM_USER_REQUIRED", message: "This endpoint is available to CRM users only", status: 403 },
  });
}

module.exports = { requireCrmUser };
