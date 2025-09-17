const express = require("express");
const router = express.Router();
const { authenticate, requireTenant } = require("../middlewares/auth");
const { meRateLimit } = require("../middlewares/security.mw");
const { getMeProfile } = require("../controllers/me.controller");

/**
 * GET /me - Get current user profile
 *
 * Returns minimal, authoritative snapshot of the signed-in user
 * with tenant isolation and caching support.
 *
 * Headers:
 * - Authorization: Bearer <token> (required)
 * - If-None-Match: <etag> (optional, for 304 responses)
 * - X-Correlation-ID: <id> (optional, for tracking)
 *
 * Response Headers:
 * - ETag: <hash> (for caching)
 * - X-Policy-Version: <version> (policy version)
 * - Cache-Control: private, max-age=300
 *
 * Security:
 * - Rate limited (100 requests per 15 minutes)
 * - Tenant isolation enforced
 * - Redis caching with fallback to DB
 * - No sensitive data in logs
 */
router.get(
  "/me",
  meRateLimit, // Rate limiting for /me endpoint
  authenticate, // JWT authentication
  requireTenant, // Tenant context validation
  getMeProfile // Get user profile
);

module.exports = router;
