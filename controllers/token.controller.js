const jwt = require("jsonwebtoken");

/**
 * Token inspection endpoint for testing
 * This endpoint helps decode and inspect JWT tokens during testing
 */
module.exports.decodeToken = async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token is required",
      });
    }

    // Decode token without verification (for inspection)
    const decoded = jwt.decode(token);

    if (!decoded) {
      return res.status(400).json({
        success: false,
        error: "Invalid token format",
      });
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

      // Tenant-specific claims
      tenantId: decoded.tid || decoded.tenantId,

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
      tenantId: decoded.tenantId,
      tfp: decoded.tfp,
      ver: decoded.ver,

      // Entra specific
      tid: decoded.tid,
      preferred_username: decoded.preferred_username,
    };

    // Determine token type
    let tokenType = "Unknown";
    if (decoded.tenantId) {
      tokenType = "Azure AD B2C";
    } else if (decoded.tid && decoded.preferred_username) {
      tokenType = "Azure Entra ID";
    } else if (decoded.tid && decoded.userType) {
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
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

/**
 * Validate internal JWT endpoint
 */
module.exports.validateInternalJWT = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Access token required",
      });
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Check for required claims
      const validation = {
        hasTenantId: !!decoded.tid,
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
          tenantId: decoded.tid,
          userId: decoded.sub || decoded.id,
          email: decoded.email,
          userType: decoded.userType,
          roles: decoded.roles,
          permissions: decoded.permissions,
        },
      });
    } catch (jwtError) {
      res.status(401).json({
        success: false,
        error: "Invalid token",
        details: jwtError.message,
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

/**
 * External service token validation endpoint
 * Simplified endpoint for other services to validate tokens
 */
module.exports.validateTokenForService = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Bearer token required",
        code: "MISSING_TOKEN",
      });
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
          tenantId: decoded.tid,
          email: decoded.email,
          userType: decoded.userType,
          roles: decoded.roles || [],
          permissions: decoded.permissions || [],
        },
        expiresAt: new Date(decoded.exp * 1000).toISOString(),
      });
    } catch (jwtError) {
      res.status(401).json({
        success: false,
        valid: false,
        error: "Invalid or expired token",
        code: "INVALID_TOKEN",
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "SERVER_ERROR",
    });
  }
};

/**
 * Generate test token for development/testing
 */
module.exports.generateTestToken = async (req, res) => {
  try {
    const {
      userId = "test-user",
      tenantId = "test-tenant",
      email = "test@example.com",
    } = req.body;

    const testPayload = {
      sub: userId,
      tid: tenantId,
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
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
