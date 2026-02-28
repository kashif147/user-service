const UserHandler = require("../handlers/user.handler");
const joiSchemas = require("../validation/crm.general.schema");
const { encryptToken } = require("../helpers/tokenEncryption");
const { AppError } = require("../errors/AppError");

module.exports.handleRegistration = async (req, res, next) => {
  try {
    const results = await joiSchemas.crm_general_register_schema.validateAsync(
      req.body
    );

    console.log("results", results);

    // Extract tenantId from request - NEVER use bypass values
    // Priority: request body > headers > environment default
    const tenantId = 
      req.body.tenantId || 
      req.headers["x-tenant-id"] || 
      process.env.DEFAULT_TENANT_ID;
    
    if (!tenantId) {
      return next(AppError.badRequest("Tenant ID is required. Provide tenantId in request body or X-Tenant-ID header, or set DEFAULT_TENANT_ID environment variable."));
    }
    
    // SECURITY: Reject bypass tenant values
    if (tenantId === "bypass-tenant" || tenantId === "bypass-user") {
      return next(AppError.badRequest("Invalid tenant ID. Bypass values are not allowed for registration."));
    }

    const isEmailExists = await UserHandler.findUserByEmail(
      results.email,
      tenantId
    );
    if (isEmailExists) {
      return next(AppError.conflict("User already exists"));
    }

    // For registration, createdBy is null since user doesn't exist yet
    // If an admin is creating the user, they should be authenticated and their ID passed via header
    const createdBy = req.headers["x-user-id"] || null;
    
    // SECURITY: Reject bypass user values
    if (createdBy === "bypass-user") {
      return next(AppError.badRequest("Invalid creator ID. Bypass values are not allowed."));
    }

    const result = await UserHandler.handleNewUser(
      results.email,
      results.password,
      tenantId,
      createdBy
    );

    // Encrypt the token before sending to frontend
    if (result.token) {
      result.token = encryptToken(result.token);
    }

    return res.status(201).json({ status: "success", data: result });
  } catch (error) {
    console.error("Registration Error:", error);
    if (error.isJoi) {
      return next(
        AppError.badRequest(error.details.map((d) => d.message).join(", "))
      );
    }
    return next(AppError.internalServerError("Registration failed"));
  }
};

module.exports.handleLogin = async (req, res, next) => {
  try {
    const results = await joiSchemas.crm_general_login_schema.validateAsync(
      req.body
    );

    // Extract tenantId from request - NEVER use bypass values
    // Priority: request body > headers > environment default
    const tenantId = 
      req.body.tenantId || 
      req.headers["x-tenant-id"] || 
      process.env.DEFAULT_TENANT_ID;
    
    if (!tenantId) {
      return next(AppError.badRequest("Tenant ID is required. Provide tenantId in request body or X-Tenant-ID header, or set DEFAULT_TENANT_ID environment variable."));
    }
    
    // SECURITY: Reject bypass tenant values
    if (tenantId === "bypass-tenant" || tenantId === "bypass-user") {
      return next(AppError.badRequest("Invalid tenant ID. Bypass values are not allowed for login."));
    }

    const isEmailExists = await UserHandler.findUserByEmail(
      results.email,
      tenantId
    );
    if (!isEmailExists) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    const data = await UserHandler.handleLogin(
      results.email,
      results.password,
      tenantId
    );

    // Encrypt the token before sending to frontend
    if (data.token) {
      data.token = encryptToken(data.token);
    }

    return res.status(200).json({ status: "success", data });
  } catch (error) {
    console.error("Login Error:", error);
    if (error.isJoi) {
      return next(
        AppError.badRequest(error.details.map((d) => d.message).join(", "))
      );
    }
    return next(AppError.internalServerError("Login failed"));
  }
};

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
        console.log(`[${requestId}] 🚀 Sending response: HTTP ${status}`);
        console.log(
          `[${requestId}] 📦 Response data:`,
          JSON.stringify(data, null, 2)
        );
        // CRITICAL: Azure B2C requires explicit Content-Type header
        res.setHeader('Content-Type', 'application/json');
        const response = res.status(status).json(data);
        console.log(
          `[${requestId}] ✅ Response sent successfully - HTTP ${status}`
        );
        return response;
      } catch (err) {
        console.error(`[${requestId}] ❌ Error sending response:`, err);
        console.error(`[${requestId}] Error stack:`, err.stack);
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
    console.log(
      `[${requestId}] Request body:`,
      JSON.stringify(req.body, null, 2)
    );
    console.log(
      `[${requestId}] Request headers:`,
      JSON.stringify(req.headers, null, 2)
    );

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

    // Log extracted values for debugging
    if (memberno || mobilephone) {
      console.log(`[${requestId}] 📋 Extracted extension attributes:`, {
        memberno: memberno || "not provided",
        mobilephone: mobilephone || "not provided",
      });
    }

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
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      const profileServiceDuration = Date.now() - profileServiceStartTime;
      console.log(`[${requestId}] ⏱️  Profile service response time: ${profileServiceDuration}ms`);
      console.log(`[${requestId}] 📥 Profile service response:`, JSON.stringify(profileResponse.data, null, 2));

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
        
        const defaultTenantId = process.env.DEFAULT_TENANT_ID || "default-tenant-id";
        
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
    console.error(`[${requestId}] ❌ User Validation Error:`, error);
    console.error(`[${requestId}] Stack:`, error.stack);
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
    console.error("FATAL: validateUser threw synchronously:", outerError);
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
