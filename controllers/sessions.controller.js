const { jwtVerify, createRemoteJWKSet, SignJWT } = require("jose");
const azureB2CConfig = require("../config/azure-b2c");
const crypto = require("crypto");

class SessionsController {
  // POST /sessions
  async createSession(req, res) {
    try {
      const { id_token } = req.body;

      if (!id_token) {
        return res.status(400).json({
          success: false,
          error: {
            message: "Missing id_token in request body",
            code: "MISSING_ID_TOKEN",
          },
        });
      }

      // Validate B2C ID token
      const tokenPayload = await this.validateB2CToken(id_token);

      // Map B2C claims to internal user
      const internalUser = this.mapB2CToInternalUser(tokenPayload);

      // Issue internal JWT
      const internalJwt = await this.issueInternalJWT(internalUser);

      // Return session data
      res.json({
        success: true,
        data: {
          jwt: internalJwt,
          profile: {
            sub: internalUser.sub,
            email: internalUser.email,
            name: internalUser.name,
            roles: internalUser.roles,
            tenantId: internalUser.tenantId,
          },
        },
      });
    } catch (error) {
      console.error("Error in createSession:", error.message);

      let statusCode = 500;
      let errorCode = "SESSION_CREATION_FAILED";

      if (error.message.includes("validation")) {
        statusCode = 401;
        errorCode = "TOKEN_VALIDATION_FAILED";
      } else if (error.message.includes("expired")) {
        statusCode = 401;
        errorCode = "TOKEN_EXPIRED";
      }

      res.status(statusCode).json({
        success: false,
        error: {
          message: error.message,
          code: errorCode,
        },
      });
    }
  }

  async validateB2CToken(idToken) {
    try {
      // Create JWKS client for B2C
      const JWKS = createRemoteJWKSet(new URL(azureB2CConfig.jwksUrl));

      // Verify the B2C token
      const { payload } = await jwtVerify(idToken, JWKS, {
        issuer: `https://${azureB2CConfig.tenantName}.b2clogin.com/${azureB2CConfig.tenantId}/v2.0/`,
        audience: azureB2CConfig.clientId,
      });

      // Validate policy
      if (!azureB2CConfig.allowedPolicies.includes(payload.tfp)) {
        throw new Error(`Invalid policy: ${payload.tfp}`);
      }

      // Validate required claims
      if (!payload.oid || !payload.email) {
        throw new Error("Missing required claims: oid or email");
      }

      return payload;
    } catch (error) {
      throw new Error(`B2C token validation failed: ${error.message}`);
    }
  }

  mapB2CToInternalUser(tokenPayload) {
    // Use oid as stable user ID
    const internalUserId = `b2c_${tokenPayload.oid}`;

    return {
      sub: internalUserId,
      b2c_sub: tokenPayload.oid,
      email: tokenPayload.email,
      name: tokenPayload.name || tokenPayload.given_name || tokenPayload.email,
      tenantId: tokenPayload.tid || null,
      roles: ["member"], // Default role
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
    };
  }

  async issueInternalJWT(userData) {
    const secret = new TextEncoder().encode(azureB2CConfig.jwtSecret);

    const jwt = await new SignJWT({
      sub: userData.sub,
      b2c_sub: userData.b2c_sub,
      tenantId: userData.tenantId,
      roles: userData.roles,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(userData.iat)
      .setExpirationTime(userData.exp)
      .setIssuer("user-service")
      .setAudience("portal-service")
      .sign(secret);

    return jwt;
  }
}

module.exports = new SessionsController();
