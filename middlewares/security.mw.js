const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { AppError } = require("../errors/AppError");
const { connectDB } = require("../config/db");
const User = require("../models/user");

/**
 * Security Headers Middleware
 * Implements comprehensive security headers
 */
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  crossOriginEmbedderPolicy: false, // Disable for API compatibility
});

/**
 * Rate Limiting for Authentication Endpoints
 */
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: {
    error: {
      message: "Too many authentication attempts",
      code: "RATE_LIMIT_EXCEEDED",
      status: 429,
      retryAfter: "15 minutes",
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for super users or in development
    return (
      req.ctx?.roles?.includes("SU") || process.env.NODE_ENV === "development"
    );
  },
});

/**
 * General API Rate Limiting
 */
const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: {
      message: "Too many requests",
      code: "RATE_LIMIT_EXCEEDED",
      status: 429,
      retryAfter: "15 minutes",
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for super users or in development
    return (
      req.ctx?.roles?.includes("SU") || process.env.NODE_ENV === "development"
    );
  },
});

/**
 * Server-Side Role Validation Middleware
 * Validates user roles against database on each request
 */
const validateRolesFromDatabase = async (req, res, next) => {
  try {
    // Skip validation for super users or in development mode
    if (
      req.ctx?.roles?.includes("SU") ||
      process.env.NODE_ENV === "development"
    ) {
      return next();
    }

    const { userId, tenantId } = req.ctx;

    if (!userId || !tenantId) {
      const authError = AppError.badRequest("Missing user or tenant context", {
        authError: true,
        missingContext: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingContext: authError.missingContext,
        },
      });
    }

    // Fetch user from database with roles
    const user = await User.findOne({
      _id: userId,
      tenantId,
      isActive: true,
    }).populate("roles");

    if (!user) {
      const authError = AppError.badRequest("User not found or inactive", {
        authError: true,
        userNotFound: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          userNotFound: authError.userNotFound,
        },
      });
    }

    // Validate tenant context
    if (user.tenantId.toString() !== tenantId) {
      const authError = AppError.badRequest("Tenant context mismatch", {
        authError: true,
        tenantMismatch: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          tenantMismatch: authError.tenantMismatch,
        },
      });
    }

    // Update request context with database roles
    const dbRoles = user.roles.map((role) => role.code);
    const dbPermissions = [];

    user.roles.forEach((role) => {
      if (role.permissions) {
        dbPermissions.push(...role.permissions);
      }
    });

    req.ctx.dbRoles = dbRoles;
    req.ctx.dbPermissions = dbPermissions;
    req.ctx.dbUser = user;

    // Validate token roles against database roles
    const tokenRoles = req.ctx.roles || [];
    const hasValidRoles = tokenRoles.every((role) => dbRoles.includes(role));

    if (!hasValidRoles) {
      const authError = AppError.badRequest("Invalid role claims in token", {
        authError: true,
        invalidRoles: true,
        tokenRoles,
        dbRoles,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          invalidRoles: authError.invalidRoles,
        },
      });
    }

    next();
  } catch (error) {
    console.error("Role validation error:", error);
    const authError = AppError.badRequest("Role validation failed", {
      authError: true,
      validationError: error.message,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        authError: authError.authError,
        validationError: authError.validationError,
      },
    });
  }
};

/**
 * Enhanced Error Handler
 * Prevents information leakage in error responses
 */
const sanitizedErrorHandler = (error, req, res, next) => {
  console.error("Error:", error);

  // Don't reveal sensitive information in production
  const isProduction = process.env.NODE_ENV === "production";

  let sanitizedError = {
    message: "An error occurred",
    code: "INTERNAL_ERROR",
    status: 500,
    timestamp: new Date().toISOString(),
  };

  // Handle known error types
  if (error.name === "ValidationError") {
    sanitizedError = {
      message: "Validation failed",
      code: "VALIDATION_ERROR",
      status: 400,
      timestamp: new Date().toISOString(),
    };
  } else if (error.name === "CastError") {
    sanitizedError = {
      message: "Invalid ID format",
      code: "INVALID_ID",
      status: 400,
      timestamp: new Date().toISOString(),
    };
  } else if (error.name === "JsonWebTokenError") {
    sanitizedError = {
      message: "Invalid token",
      code: "INVALID_TOKEN",
      status: 401,
      timestamp: new Date().toISOString(),
    };
  } else if (error.name === "TokenExpiredError") {
    sanitizedError = {
      message: "Token expired",
      code: "TOKEN_EXPIRED",
      status: 401,
      timestamp: new Date().toISOString(),
    };
  } else if (error.name === "MongoError" || error.name === "MongoServerError") {
    sanitizedError = {
      message: "Database error",
      code: "DATABASE_ERROR",
      status: 500,
      timestamp: new Date().toISOString(),
    };
  }

  // Add development-specific details
  if (!isProduction) {
    sanitizedError.stack = error.stack;
    sanitizedError.details = error.message;
  }

  res.status(sanitizedError.status).json({
    error: sanitizedError,
  });
};

/**
 * Request ID Middleware
 * Adds unique request ID for tracking
 */
const requestId = (req, res, next) => {
  req.requestId =
    req.headers["x-request-id"] ||
    `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  res.setHeader("X-Request-ID", req.requestId);
  next();
};

/**
 * CORS Configuration
 */
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
      "http://localhost:3000",
      "http://localhost:3001",
    ];

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "X-Request-ID",
  ],
};

module.exports = {
  securityHeaders,
  authRateLimit,
  apiRateLimit,
  validateRolesFromDatabase,
  sanitizedErrorHandler,
  requestId,
  corsOptions,
};
