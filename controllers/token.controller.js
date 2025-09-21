const jwt = require("jsonwebtoken");
const { AppError } = require("../errors/AppError");

/**
 * Token inspection endpoint for testing
 * This endpoint helps decode and inspect JWT tokens during testing
 */
module.exports.decodeToken = async (req, res, next) => {
  try {
    const { token } = req.body;

    if (!token) {
      return next(AppError.badRequest("Token is required"));
    }

    // Decode token without verification (for inspection)
    const decoded = jwt.decode(token);

    if (!decoded) {
      return next(AppError.badRequest("Invalid token format"));
    }

    // Extract relevant claims
    const claims = {
      // Standard claims
      iss: decoded.iss,
      aud: decoded.aud,
      exp: decoded.exp,
      iat: decoded.iat,
      sub: decoded.sub,
      oid: decoded.oid,

      // Tenant-specific claims - prioritize tenantId, then tid, then extension_tenantId
      tenantId: decoded.tenantId || decoded.tid || decoded.extension_tenantId,

      // User information
      email: decoded.emails?.[0] || decoded.preferred_username || decoded.email,
      name: decoded.name,
      given_name: decoded.given_name,
      family_name: decoded.family_name,

      // Internal JWT claims
      id: decoded.id,
      userType: decoded.userType,
      roles: decoded.roles,
      permissions: decoded.permissions,

      // B2C specific
      tfp: decoded.tfp,
      ver: decoded.ver,
      extension_tenantId: decoded.extension_tenantId,

      // Entra specific
      preferred_username: decoded.preferred_username,
    };

    // Determine token type
    let tokenType = "Unknown";
    const extractedTenantId =
      decoded.tenantId || decoded.tid || decoded.extension_tenantId;

    if (extractedTenantId && decoded.tfp) {
      tokenType = "Azure AD B2C";
    } else if (extractedTenantId && decoded.preferred_username) {
      tokenType = "Azure Entra ID";
    } else if (extractedTenantId && decoded.userType) {
      tokenType = "Internal JWT";
    }

    // Check if token is expired
    const now = Math.floor(Date.now() / 1000);
    const isExpired = decoded.exp && decoded.exp < now;

    res.json({
      success: true,
      tokenType,
      isExpired,
      claims,
      raw: decoded,
    });
  } catch (error) {
    console.error("Token decode error:", error);
    return next(AppError.internalServerError("Failed to decode token"));
  }
};

/**
 * Validate internal JWT endpoint
 */
module.exports.validateInternalJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(AppError.unauthorized("Access token required"));
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Check for required claims
      const validation = {
        hasTenantId: !!decoded.tenantId,
        hasUserId: !!(decoded.sub || decoded.id),
        hasEmail: !!decoded.email,
        hasRoles: !!decoded.roles,
        hasPermissions: !!decoded.permissions,
      };

      const isValid = Object.values(validation).every(Boolean);

      res.json({
        success: true,
        isValid,
        validation,
        claims: {
          tenantId: decoded.tenantId,
          userId: decoded.sub || decoded.id,
          email: decoded.email,
          userType: decoded.userType,
          roles: decoded.roles,
          permissions: decoded.permissions,
        },
      });
    } catch (jwtError) {
      return next(AppError.unauthorized("Invalid token"));
    }
  } catch (error) {
    console.error("JWT validation error:", error);
    return next(AppError.internalServerError("Failed to validate JWT"));
  }
};

/**
 * External service token validation endpoint
 * Simplified endpoint for other services to validate tokens
 */
module.exports.validateTokenForService = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(AppError.unauthorized("Bearer token required"));
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Return minimal user context for external services
      res.json({
        success: true,
        valid: true,
        user: {
          id: decoded.sub || decoded.id,
          tenantId: decoded.tenantId,
          email: decoded.email,
          userType: decoded.userType,
          roles: decoded.roles || [],
          permissions: decoded.permissions || [],
        },
        expiresAt: new Date(decoded.exp * 1000).toISOString(),
      });
    } catch (jwtError) {
      return next(AppError.unauthorized("Invalid or expired token"));
    }
  } catch (error) {
    console.error("Token validation service error:", error);
    return next(
      AppError.internalServerError("Failed to validate token for service")
    );
  }
};

/**
 * Generate test token for development/testing
 */
module.exports.generateTestToken = async (req, res, next) => {
  try {
    const {
      userId = "test-user",
      tenantId = "test-tenant",
      email = "test@example.com",
    } = req.body;

    const testPayload = {
      sub: userId,
      tenantId: tenantId,
      id: userId,
      email: email,
      userType: "member",
      roles: [{ id: "role1", code: "MEMBER", name: "Member" }],
      permissions: ["read:profile", "update:profile"],
    };

    const token = jwt.sign(testPayload, process.env.JWT_SECRET, {
      expiresIn: "24h",
    });

    res.json({
      success: true,
      token: `Bearer ${token}`,
      payload: testPayload,
      expiresIn: "24h",
    });
  } catch (error) {
    console.error("Test token generation error:", error);
    return next(AppError.internalServerError("Failed to generate test token"));
  }
};
