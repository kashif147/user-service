const UserHandler = require("../handlers/user.handler");
const { AppError } = require("../errors/AppError");

module.exports.getUserByEmail = async (req, res, next) => {
  try {
    const { email } = req.params;

    // Extract tenantId from request context
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return next(AppError.badRequest("Tenant context required"));
    }

    const user = await UserHandler.findUserByEmail(email, tenantId);
    if (!user) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    // Return user data without sensitive information
    const userData = {
      id: user._id,
      email: user.userEmail,
      firstName: user.userFirstName,
      lastName: user.userLastName,
      fullName: user.userFullName,
      userType: user.userType,
      tenantId: user.tenantId,
      isActive: user.isActive,
      createdAt: user.createdAt,
    };

    return res.status(200).json({ status: "success", data: userData });
  } catch (error) {
    console.error("Get User by Email Error:", error);
    return next(AppError.internalServerError("Failed to retrieve user"));
  }
};

// Loggable fields of an error on the B2C sign-up path. An HTTP client (axios) error carries the
// forwarded request body and headers in its config, so it is never logged whole.
const safeErrorFields = (error) => ({
  name: error?.name || null,
  code: error?.code || null,
  status: error?.response?.status || null,
});

const validateUserInternal = async (req, res, next) => {
  // CRITICAL: Don't call next() with errors - Azure B2C requires HTTP 200 always
  // Wrap entire function to catch any unhandled errors

  const requestId = `b2c-${Date.now()}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  const startTime = Date.now();

  // Azure B2C has a 30-second timeout for API connectors
  // Set response timeout to ensure we respond within 20 seconds (leaving buffer)
  const RESPONSE_TIMEOUT = 20000; // 20 seconds
  let timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      console.error(
        `[${requestId}] ⚠️ Request timeout - responding with error`
      );
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({
        version: "1.0.0",
        action: "ShowBlockPage",
        userMessage: "Request timed out. Please try again.",
      });
    }
  }, RESPONSE_TIMEOUT);

  // Ensure response is sent only once
  const sendResponse = (status, data) => {
    if (!res.headersSent) {
      clearTimeout(timeoutId);
      try {
        // Action only: the response can carry the user's email and names.
        console.log(`[${requestId}] 🚀 Sending response: HTTP ${status}`, {
          action: data?.action || null,
        });
        // CRITICAL: Azure B2C requires explicit Content-Type header
        res.setHeader('Content-Type', 'application/json');
        const response = res.status(status).json(data);
        console.log(
          `[${requestId}] ✅ Response sent successfully - HTTP ${status}`
        );
        return response;
      } catch (err) {
        console.error(`[${requestId}] ❌ Error sending response:`, safeErrorFields(err));
        // If response already sent, ignore
        return;
      }
    } else {
      console.warn(
        `[${requestId}] ⚠️  Response headers already sent - cannot send again`
      );
      return false; // Headers already sent
    }
  };

  try {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`[${requestId}] === Azure B2C User Flow Validation ===`);
    console.log(`[${requestId}] Timestamp: ${new Date().toISOString()}`);
    // The request body (email, names, member number, phone) and headers (Basic auth) are
    // never logged.

    // Azure B2C User Flows send data in a different format
    // Extension attributes come with format: extension_<appId>_<attributeName>
    // Extract extension attributes and map to simplified field names
    let memberno = null;
    let mobilephone = null;

    // Scan for extension attributes (format: extension_<appId>_<AttributeName>)
    for (const [key, value] of Object.entries(req.body)) {
      if (key.startsWith("extension_")) {
        const lowerKey = key.toLowerCase();
        // Match MemberNo (case insensitive)
        if (lowerKey.includes("memberno") || lowerKey.endsWith("_memberno")) {
          memberno = value;
        }
        // Match mobilePhone (case insensitive)
        if (
          lowerKey.includes("mobilephone") ||
          lowerKey.endsWith("_mobilephone")
        ) {
          mobilephone = value;
        }
      }
    }

    const {
      email,
      givenName,
      surname,
      // memberno and mobilephone extracted above from extension attributes
      displayName,
      jobTitle,
      streetAddress,
      city,
      state,
      country,
      step,
      client_id,
      ui_locales,
      // Additional fields that might be sent by Azure B2C
      objectId,
      identities,
      ...otherClaims
    } = req.body;

    // Use extension attributes if found, otherwise use direct field names
    memberno = memberno || req.body.memberno || null;
    mobilephone = mobilephone || req.body.mobilephone || null;

    // Presence only, never the values.
    console.log(`[${requestId}] 📋 Extension attributes present:`, {
      memberno: Boolean(memberno),
      mobilephone: Boolean(mobilephone),
    });

    // Validate required fields for User Flows
    // NOTE: Azure B2C supports both HTTP 200 and HTTP 400 for ValidationError
    // Using HTTP 400 for field validation errors (per Azure B2C docs)
    if (!email) {
      console.log(`[${requestId}] ❌ Validation failed: Email is required`);
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] Response time: ${duration}ms`);
      console.log(`[${requestId}] ${"=".repeat(80)}\n`);
      return sendResponse(400, {
        version: "1.0.0",
        status: 400,
        action: "ValidationError",
        userMessage: "Email is required.",
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.log(`[${requestId}] ❌ Validation failed: Invalid email format`);
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] Response time: ${duration}ms`);
      console.log(`[${requestId}] ${"=".repeat(80)}\n`);
      return sendResponse(400, {
        version: "1.0.0",
        status: 400,
        action: "ValidationError",
        userMessage: "Please enter a valid email address.",
      });
    }

    // Validate mobile phone if provided
    if (mobilephone && !/^\+?[\d\s\-\(\)]{10,}$/.test(mobilephone)) {
      console.log(`[${requestId}] ❌ Validation failed: Invalid mobile phone`);
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] Response time: ${duration}ms`);
      console.log(`[${requestId}] ${"=".repeat(80)}\n`);
      return sendResponse(400, {
        version: "1.0.0",
        status: 400,
        action: "ValidationError",
        userMessage: "Please enter a valid mobile phone number.",
      });
    }

    // Validate member number if provided (assuming it should be alphanumeric)
    if (memberno && !/^[A-Za-z0-9\-_]{3,20}$/.test(memberno)) {
      console.log(`[${requestId}] ❌ Validation failed: Invalid member number`);
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] Response time: ${duration}ms`);
      console.log(`[${requestId}] ${"=".repeat(80)}\n`);
      return sendResponse(400, {
        version: "1.0.0",
        status: 400,
        action: "ValidationError",
        userMessage: "Please enter a valid member number.",
      });
    }

    console.log(`[${requestId}] 🔍 Forwarding validation to profile-service`);
    console.log(`[${requestId}] 📋 Step: ${step || "not provided"}`);
    console.log(`[${requestId}] 🆔 Client ID: ${client_id || "not provided"}`);

    // IMPORTANT: Forward validation to profile-service
    // Profile-service will check for duplicate profiles (membership records)
    // This ensures we're checking against actual member profiles, not just user accounts
    // Trusted tenant (Phase 2C B): resolved from the B2C app (client_id) of this
    // authenticated connector call, never from a tenantId in the body. No unique tenant ->
    // fail closed: sign-up must not be validated (or later linked) against another tenant.
    const { resolveB2CConnectorTenantId } = require("../helpers/b2cConnectorTenant");
    const trustedTenantId = await resolveB2CConnectorTenantId(client_id);
    if (!trustedTenantId) {
      console.warn(`[${requestId}] 🚫 No unique tenant for this B2C application - blocking sign-up validation`);
      return sendResponse(200, {
        version: "1.0.0",
        action: "ShowBlockPage",
        userMessage: "Sign-up is not available for this application. Please contact support.",
      });
    }

    const profileServiceUrl = process.env.PROFILE_SERVICE_URL || 'http://localhost:3002';
    const profileValidationUrl = `${profileServiceUrl}/api/profile/validate`;

    console.log(`[${requestId}] 🔗 Calling profile-service: ${profileValidationUrl}`);

    const profileServiceStartTime = Date.now();
    
    try {
      const axios = require('axios');
      
      // Forward the entire request body to profile-service
      const profileResponse = await axios.post(
        profileValidationUrl,
        req.body,
        {
          timeout: 15000, // 15 second timeout
          // Genuine service-to-service call (no user token): the trusted tenant travels in
          // x-tenant-id; profile-service ignores any tenantId in the forwarded body.
          headers: {
            'Content-Type': 'application/json',
            'x-internal-request': 'true',
            'x-tenant-id': trustedTenantId,
          }
        }
      );

      const profileServiceDuration = Date.now() - profileServiceStartTime;
      console.log(`[${requestId}] ⏱️  Profile service response time: ${profileServiceDuration}ms`);
      // Outcome only: the profile-service response can carry personal data.
      console.log(`[${requestId}] 📥 Profile service response:`, {
        status: profileResponse.status,
        action: profileResponse.data?.action || null,
        tenantId: trustedTenantId,
      });

      // Forward the profile-service response directly to Azure B2C
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] ⏱️  Total response time: ${duration}ms`);
      console.log(`[${requestId}] ${"=".repeat(80)}\n`);

      // Return the response from profile-service with appropriate HTTP status
      if (profileResponse.data.action === 'ValidationError' && profileResponse.data.status === 400) {
        return sendResponse(400, profileResponse.data);
      } else {
        return sendResponse(200, profileResponse.data);
      }
    } catch (profileServiceError) {
      const profileServiceDuration = Date.now() - profileServiceStartTime;
      console.error(`[${requestId}] ❌ Profile service call failed after ${profileServiceDuration}ms:`, profileServiceError.message);
      
      // If profile-service is down or times out, fail open (allow signup)
      // This ensures Azure B2C signup isn't blocked by profile-service issues
      if (profileServiceError.code === 'ECONNREFUSED' || profileServiceError.code === 'ETIMEDOUT') {
        console.warn(`[${requestId}] ⚠️ Profile service unavailable - allowing signup (fail open)`);
        
        const defaultTenantId = trustedTenantId; // trusted connector tenant, never a "default" fallback
        
        const duration = Date.now() - startTime;
        console.log(`[${requestId}] ⏱️  Total response time: ${duration}ms`);
        console.log(`[${requestId}] ${"=".repeat(80)}\n`);
        
        return sendResponse(200, {
          version: "1.0.0",
          action: "Continue",
          email: email,
          tenantId: defaultTenantId,
          ...(givenName && { givenName }),
          ...(surname && { surname }),
          ...(displayName && { displayName }),
        });
      }
      
      // For other errors, re-throw to be caught by outer catch block
      throw profileServiceError;
    }
  } catch (error) {
    // Never the error object: an HTTP client error carries the forwarded request body.
    console.error(`[${requestId}] ❌ User Validation Error:`, safeErrorFields(error));
    const duration = Date.now() - startTime;
    console.log(`[${requestId}] ⏱️  Error response time: ${duration}ms`);
    console.log(`[${requestId}] ${"=".repeat(80)}\n`);

    // Return ShowBlockPage for unexpected errors (blocks user but allows retry)
    // Use HTTP 200 for system errors (not field validation errors)
    return sendResponse(200, {
      version: "1.0.0",
      action: "ShowBlockPage",
      userMessage: "An error occurred during validation. Please try again.",
    });
  }
};

// Export wrapped version to ensure no errors escape to global handler
module.exports.validateUser = async (req, res, next) => {
  try {
    await validateUserInternal(req, res, next);
  } catch (outerError) {
    // Final catch-all for any errors that escaped (should never happen)
    console.error("FATAL: validateUser threw synchronously:", safeErrorFields(outerError));
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({
        version: "1.0.0",
        action: "ShowBlockPage",
        userMessage: "An error occurred during validation. Please try again.",
      });
    }
  }
};
