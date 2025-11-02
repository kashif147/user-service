const UserHandler = require("../handlers/user.handler");
const joiSchemas = require("../validation/crm.general.schema");
const { AppError } = require("../errors/AppError");

module.exports.handleRegistration = async (req, res, next) => {
  try {
    const results = await joiSchemas.crm_general_register_schema.validateAsync(
      req.body
    );

    console.log("results", results);

    // Extract tenantId from request context (set by auth middleware)
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return next(AppError.badRequest("Tenant context required"));
    }

    const isEmailExists = await UserHandler.findUserByEmail(
      results.email,
      tenantId
    );
    if (isEmailExists) {
      return next(AppError.conflict("User already exists"));
    }

    const result = await UserHandler.handleNewUser(
      results.email,
      results.password,
      tenantId,
      req.ctx.userId
    );

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

    // Extract tenantId from request context
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return next(AppError.badRequest("Tenant context required"));
    }

    const isEmailExists = await UserHandler.findUserByEmail(
      results.email,
      tenantId
    );
    if (!isEmailExists) {
      return next(AppError.notFound("User not found"));
    }

    const data = await UserHandler.handleLogin(
      results.email,
      results.password,
      tenantId
    );

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
      return next(AppError.notFound("User not found"));
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
  // Set response timeout to ensure we respond within 25 seconds
  const RESPONSE_TIMEOUT = 25000; // 25 seconds
  let timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      console.error(
        `[${requestId}] ⚠️ Request timeout - responding with error`
      );
      res.status(200).json({
        version: "1.0.0",
        action: "ValidationError",
        userMessage: "Request timed out. Please try again.",
      });
    }
  }, RESPONSE_TIMEOUT);

  // Ensure response is sent only once
  const sendResponse = (status, data) => {
    if (!res.headersSent) {
      clearTimeout(timeoutId);
      try {
        return res.status(status).json(data);
      } catch (err) {
        console.error(`[${requestId}] Error sending response:`, err);
        // If response already sent, ignore
        return;
      }
    }
    return false; // Headers already sent
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
    const {
      email,
      givenName,
      surname,
      memberno, // Custom optional attribute
      mobilephone, // Custom optional attribute
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

    // Validate required fields for User Flows
    // NOTE: Azure B2C requires HTTP 200 status even for validation errors
    if (!email) {
      console.log(`[${requestId}] ❌ Validation failed: Email is required`);
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] Response time: ${duration}ms`);
      console.log(`[${requestId}] ${"=".repeat(80)}\n`);
      return sendResponse(200, {
        version: "1.0.0",
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
      return sendResponse(200, {
        version: "1.0.0",
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
      return sendResponse(200, {
        version: "1.0.0",
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
      return sendResponse(200, {
        version: "1.0.0",
        action: "ValidationError",
        userMessage: "Please enter a valid member number.",
      });
    }

    console.log(`[${requestId}] 🔍 Searching for user with email: ${email}`);
    console.log(`[${requestId}] 📋 Step: ${step || "not provided"}`);
    console.log(`[${requestId}] 🆔 Client ID: ${client_id || "not provided"}`);

    // Search for user across all tenants (public endpoint)
    // Add timeout to database query to prevent hanging
    const User = require("../models/user.model");
    const dbStartTime = Date.now();

    // Create a promise with timeout
    const queryPromise = User.findOne({
      userEmail: email,
      isActive: true,
    })
      .maxTimeMS(5000) // 5 second timeout for MongoDB query
      .lean() // Use lean() for faster query
      .exec();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Database query timeout")), 5000);
    });

    const user = await Promise.race([queryPromise, timeoutPromise]).catch(
      (error) => {
        console.error(`[${requestId}] ⚠️ Database query error:`, error.message);
        return null; // Return null on timeout/error, will be treated as user not found
      }
    );

    const dbDuration = Date.now() - dbStartTime;
    console.log(`[${requestId}] ⏱️  Database query time: ${dbDuration}ms`);

    if (!user) {
      console.log(
        `[${requestId}] ✨ User NOT found in database - NEW USER REGISTRATION`
      );

      // For new users, return input claims plus default tenantId
      // You can customize the default tenantId logic here
      const defaultTenantId =
        process.env.DEFAULT_TENANT_ID || "default-tenant-id";

      const responseData = {
        version: "1.0.0",
        action: "Continue",
        // Return all input claims
        email: email,
        ...(givenName && { givenName }),
        ...(surname && { surname }),
        ...(displayName && { displayName }),
        ...(mobilephone && { mobilephone }),
        ...(memberno && { memberno }),
        // Add tenantId for new users
        tenantId: defaultTenantId,
      };

      console.log(
        `[${requestId}] ✅ New user - returning input claims with default tenantId:`,
        JSON.stringify(responseData, null, 2)
      );
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] ⏱️  Total response time: ${duration}ms`);
      console.log(
        `[${requestId}] 📤 Response: action=Continue (Azure B2C will proceed with registration)`
      );
      console.log(`[${requestId}] ${"=".repeat(80)}\n`);
      return sendResponse(200, responseData);
    }

    console.log(`[${requestId}] 👤 User FOUND in database:`, {
      id: user._id.toString(),
      email: user.userEmail,
      userType: user.userType,
      tenantId: user.tenantId?.toString(),
      userMicrosoftId: user.userMicrosoftId || "not set",
    });

    // Block duplicate signups - if user exists in database and trying to signup
    // NOTE: Must return HTTP 200 even for ValidationError (Azure B2C requirement)
    if (step === "signup") {
      console.log(
        `[${requestId}] 🚫 BLOCKING: Existing user attempting duplicate signup!`
      );
      console.log(
        `[${requestId}] 📋 User already exists in database - preventing duplicate registration`
      );
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] ⏱️  Response time: ${duration}ms`);
      console.log(
        `[${requestId}] 📤 Response: action=ValidationError (User already exists)`
      );
      console.log(`[${requestId}] ${"=".repeat(80)}\n`);

      return sendResponse(200, {
        version: "1.0.0",
        action: "ValidationError",
        userMessage:
          "An account with this email address already exists. Please sign in instead.",
      });
    }

    // For non-signup steps (signin, profile), allow continuation
    console.log(
      `[${requestId}] ✅ User exists but step is "${step}" - allowing continuation (signin/profile update)`
    );

    // User found - prepare response data for User Flows
    const responseData = {
      version: "1.0.0",
      action: "Continue",
    };

    // Return all input claims plus user data from database
    responseData.email = email;
    if (givenName) responseData.givenName = givenName;
    if (surname) responseData.surname = surname;
    if (displayName) responseData.displayName = displayName;
    if (mobilephone) responseData.mobilephone = mobilephone;
    if (memberno) responseData.memberno = memberno;

    // Add user data from database (these will override input claims if different)
    if (user.userFirstName) {
      responseData.givenName = user.userFirstName;
    }

    if (user.userLastName) {
      responseData.surname = user.userLastName;
    }

    if (user.userFullName) {
      responseData.displayName = user.userFullName;
    }

    // Add tenant-specific attributes
    if (user.tenantId) {
      responseData.tenantId = user.tenantId.toString();
    }

    // Add additional claims that Azure B2C can use
    responseData.objectId = user._id.toString();

    // Add step-specific logic for User Flows
    if (step) {
      responseData.step = step;

      // Example: Different behavior based on step
      switch (step) {
        case "signup":
          // Additional validation for signup
          console.log(`[${requestId}] 📝 Processing signup step`);
          break;
        case "profile":
          // Additional validation for profile updates
          console.log(`[${requestId}] 👤 Processing profile step`);
          break;
        case "signin":
          // Additional validation for sign in
          console.log(`[${requestId}] 🔑 Processing signin step`);
          break;
        default:
          // Default behavior
          console.log(`[${requestId}] 🔄 Processing step: ${step || "none"}`);
          break;
      }
    }

    // Add any custom extension attributes
    // These would be configured in your Azure B2C tenant
    responseData.extension_MembershipUserType = user.userType || "Standard";
    responseData.extension_MembershipTenantId = user.tenantId?.toString() || "";

    console.log(
      `[${requestId}] ✅ Validation successful - returning claims:`,
      JSON.stringify(responseData, null, 2)
    );
    const duration = Date.now() - startTime;
    console.log(`[${requestId}] ⏱️  Total response time: ${duration}ms`);
    console.log(`[${requestId}] 📤 Response: action=Continue`);
    console.log(`[${requestId}] ${"=".repeat(80)}\n`);

    return sendResponse(200, responseData);
  } catch (error) {
    console.error(`[${requestId}] ❌ User Validation Error:`, error);
    console.error(`[${requestId}] Stack:`, error.stack);
    const duration = Date.now() - startTime;
    console.log(`[${requestId}] ⏱️  Error response time: ${duration}ms`);
    console.log(`[${requestId}] ${"=".repeat(80)}\n`);

    // Return validation error for unexpected issues
    // NOTE: Must return HTTP 200 even for errors (Azure B2C requirement)
    return sendResponse(200, {
      version: "1.0.0",
      action: "ValidationError",
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
      return res.status(200).json({
        version: "1.0.0",
        action: "ValidationError",
        userMessage: "An error occurred during validation. Please try again.",
      });
    }
  }
};
