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

module.exports.validateUser = async (req, res, next) => {
  try {
    console.log("=== Azure B2C User Flow Validation ===");
    console.log("Request body:", JSON.stringify(req.body, null, 2));
    console.log("Request headers:", req.headers);

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
    if (!email) {
      console.log("Validation failed: Email is required");
      return res.status(400).json({
        version: "1.0.0",
        status: 400,
        action: "ValidationError",
        userMessage: "Email is required.",
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.log("Validation failed: Invalid email format");
      return res.status(400).json({
        version: "1.0.0",
        status: 400,
        action: "ValidationError",
        userMessage: "Please enter a valid email address.",
      });
    }

    // Validate mobile phone if provided
    if (mobilephone && !/^\+?[\d\s\-\(\)]{10,}$/.test(mobilephone)) {
      console.log("Validation failed: Invalid mobile phone");
      return res.status(400).json({
        version: "1.0.0",
        status: 400,
        action: "ValidationError",
        userMessage: "Please enter a valid mobile phone number.",
      });
    }

    // Validate member number if provided (assuming it should be alphanumeric)
    if (memberno && !/^[A-Za-z0-9\-_]{3,20}$/.test(memberno)) {
      console.log("Validation failed: Invalid member number");
      return res.status(400).json({
        version: "1.0.0",
        status: 400,
        action: "ValidationError",
        userMessage: "Please enter a valid member number.",
      });
    }

    console.log(`Searching for user with email: ${email}`);

    // Search for user across all tenants (public endpoint)
    const User = require("../models/user.model");
    const user = await User.findOne({
      userEmail: email,
      isActive: true,
    }).exec();

    if (!user) {
      console.log("User not found in database - new user registration");

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
        "New user - returning input claims with default tenantId:",
        responseData
      );
      return res.status(200).json(responseData);
    }

    console.log("User found:", {
      id: user._id,
      email: user.userEmail,
      userType: user.userType,
      tenantId: user.tenantId,
    });

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
          console.log("Processing signup step");
          break;
        case "profile":
          // Additional validation for profile updates
          console.log("Processing profile step");
          break;
        case "signin":
          // Additional validation for sign in
          console.log("Processing signin step");
          break;
        default:
          // Default behavior
          console.log(`Processing step: ${step}`);
          break;
      }
    }

    // Add any custom extension attributes
    // These would be configured in your Azure B2C tenant
    responseData.extension_MembershipUserType = user.userType || "Standard";
    responseData.extension_MembershipTenantId = user.tenantId?.toString() || "";

    console.log("Validation successful - returning claims:", responseData);

    return res.status(200).json(responseData);
  } catch (error) {
    console.error("User Validation Error:", error);

    // Return validation error for unexpected issues
    return res.status(400).json({
      version: "1.0.0",
      status: 400,
      action: "ValidationError",
      userMessage: "An error occurred during validation. Please try again.",
    });
  }
};
