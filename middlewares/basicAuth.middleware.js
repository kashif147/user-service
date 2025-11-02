/**
 * HTTP Basic Authentication Middleware
 * For Azure B2C API connector authentication
 * Returns HTTP 200 even on auth failure (Azure B2C requirement)
 */

/**
 * Basic Auth middleware with environment variable configuration
 * Reads credentials from environment variables:
 * - B2C_API_USERNAME (required)
 * - B2C_API_PASSWORD (required)
 * 
 * If credentials are not set, Basic Auth is disabled (endpoint remains public)
 */
function azureB2CBasicAuth() {
  const username = process.env.B2C_API_USERNAME || process.env.BASIC_AUTH_USERNAME;
  const password = process.env.B2C_API_PASSWORD || process.env.BASIC_AUTH_PASSWORD;

  if (!username || !password) {
    console.warn(
      "⚠️  B2C_API_USERNAME or B2C_API_PASSWORD not set - Basic Auth disabled for validate endpoint"
    );
    console.warn(
      "⚠️  Endpoint is publicly accessible. Set B2C_API_USERNAME and B2C_API_PASSWORD to enable Basic Auth."
    );
    // Return a no-op middleware if credentials not configured
    return (req, res, next) => next();
  }

  console.log(
    `✅ Basic Auth enabled for validate endpoint - Username: ${username}`
  );

  return (req, res, next) => {
    try {
      const authHeader = req.headers.authorization || req.headers.Authorization;

      if (!authHeader || !authHeader.startsWith("Basic ")) {
        // Return HTTP 200 with ValidationError (Azure B2C requirement)
        return res.status(200).json({
          version: "1.0.0",
          action: "ValidationError",
          userMessage: "Authentication required",
        });
      }

      // Decode Basic Auth credentials
      const base64Credentials = authHeader.split(" ")[1];
      const credentials = Buffer.from(base64Credentials, "base64").toString("ascii");
      const [providedUsername, providedPassword] = credentials.split(":");

      // Validate credentials
      if (providedUsername === username && providedPassword === password) {
        // Authentication successful
        return next();
      } else {
        // Invalid credentials - return HTTP 200 with ValidationError (Azure B2C requirement)
        console.warn(
          `⚠️  Basic Auth failed - Invalid credentials for user: ${providedUsername}`
        );
        return res.status(200).json({
          version: "1.0.0",
          action: "ValidationError",
          userMessage: "Authentication failed",
        });
      }
    } catch (error) {
      console.error("Basic Auth middleware error:", error);
      // Return HTTP 200 with ValidationError on any error (Azure B2C requirement)
      return res.status(200).json({
        version: "1.0.0",
        action: "ValidationError",
        userMessage: "Authentication error occurred",
      });
    }
  };
}

module.exports = {
  azureB2CBasicAuth,
};

