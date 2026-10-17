var path = require("path");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

// Entra (CRM) sign-in has no built-in fallbacks: report missing configuration at startup (names
// only). Sign-in requests then fail closed; the rest of the service keeps running.
require("./helpers/entraConfig").logMissingEntraConfig();
// The DEV shared-directory override (ENTRA_ALLOW_SHARED_DIRECTORY / ENTRA_SHARED_DIRECTORY_ALLOWLIST)
// configured outside DEPLOYMENT_ENV=dev, or a malformed allow-list, stops the service from starting.
require("./helpers/directoryClaimPolicy").assertDirectoryClaimConfig();
// A malformed sign-in rate-limit configuration (LOGIN_RATE_LIMIT_TRUSTED_PROXY not exactly one IP,
// LOGIN_RATE_GLOBAL_ALERT not a positive integer) stops the service from starting.
require("./middlewares/loginStartRateLimit").assertLoginRateLimitConfig();

// Suppress Application Insights warnings if not configured
// Azure App Service auto-injects Application Insights, but warnings appear if key is missing
// Must be done BEFORE any other require/import statements to catch early initialization
if (
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING &&
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING.trim() === ""
) {
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = undefined;
}
if (
  !process.env.APPINSIGHTS_INSTRUMENTATIONKEY ||
  process.env.APPINSIGHTS_INSTRUMENTATIONKEY.trim() === ""
) {
  // Suppress stderr FIRST (most important for Azure platform logs)
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk, encoding, callback) {
    const message = chunk.toString();
    if (
      message.includes("ApplicationInsights") &&
      (message.includes("instrumentation key") || message.includes("iKey"))
    ) {
      return true;
    }
    return originalStderrWrite(chunk, encoding, callback);
  };

  // Then suppress console methods
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  console.warn = function (...args) {
    const message = args.join(" ");
    if (
      message.includes("ApplicationInsights") &&
      (message.includes("instrumentation key") || message.includes("iKey"))
    ) {
      return;
    }
    originalConsoleWarn.apply(console, args);
  };

  console.error = function (...args) {
    const message = args.join(" ");
    if (
      message.includes("ApplicationInsights") &&
      (message.includes("instrumentation key") || message.includes("iKey"))
    ) {
      return;
    }
    originalConsoleError.apply(console, args);
  };
}

var createError = require("http-errors");
var express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerSpecs = require("./config/swagger");

const { mongooseConnection } = require("./config/db");
const session = require("express-session");

const loggerMiddleware = require("./middlewares/logger.mw");
const responseMiddleware = require("./middlewares/response.mw");
const { securityHeaders } = require("./middlewares/security.mw");
const {
  corsMiddleware,
  handlePreflight,
  corsErrorHandler,
} = require("./config/cors");
const crypto = require("crypto");
const bizLogger = require("./config/bizLogger.js");
const {
  correlationIdMiddleware,
  logErrorMiddleware,
  createSystemLogsRouter,
} = require("@projectShell/logging-lib");

var app = express();

// Disable Express automatic ETag generation (304 responses)
// Note: /me endpoint has explicit ETag handling, this only affects other routes
app.set("etag", false);

app.use(correlationIdMiddleware);

/**
 * Gateway header debug – enable with LOG_GATEWAY_DEBUG=true
 */
if (String(process.env.LOG_GATEWAY_DEBUG || "").toLowerCase() === "true") {
  app.use((req, res, next) => {
    console.log("==================================");
    console.log("SERVICE HEADERS CHECK");
    console.log("METHOD:", req.method);
    console.log("PATH:", req.originalUrl);
    console.log("x-jwt-verified:", req.headers["x-jwt-verified"]);
    console.log("x-gateway-signature:", req.headers["x-gateway-signature"]);
    console.log("x-gateway-timestamp:", req.headers["x-gateway-timestamp"]);
    console.log("x-user-id:", req.headers["x-user-id"]);
    console.log("x-tenant-id:", req.headers["x-tenant-id"]);
    console.log("==================================");
    next();
  });
}

app.use(responseMiddleware);

mongooseConnection();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "200mb" }));

app.use("/api", createSystemLogsRouter(bizLogger));

// Request log: safe metadata only (method, route, status, duration, ids) - never bodies or headers
app.use(loggerMiddleware);

// Security middleware
app.use(securityHeaders);

// CORS middleware with enhanced configuration
// app.use(handlePreflight);
// app.use(corsMiddleware);
// app.use(corsErrorHandler);

app.use(
  session({
    secret: "secret2024",
    resave: false,
    saveUninitialized: false,
  })
);

app.set("view engine", "ejs");

app.use(express.static("public"));

// Swagger documentation
app.use(
  "/swagger",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpecs, {
    explorer: true,
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "User Service API Documentation",
  })
);

app.get("/", require("./controllers/root.controller").root);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP" });
});

app.use("/", require("./routes/index"));

app.use(function (req, res, next) {
  next(createError(404));
});

app.use(logErrorMiddleware(bizLogger));

// Enhanced error handler for AppError and other errors
app.use((err, req, res, next) => {
  const correlationId =
    req.correlationId || req.headers["x-correlation-id"] || crypto.randomUUID();

  // Handle AppError instances
  // Phase 1C-2S: diagnostics (stack/extras) only when NODE_ENV === "development".
  if (err.name === "AppError") {
    return res.status(err.status).json({
      success: false,
      error: {
        message: err.message,
        code: err.code,
        status: err.status,
        ...(responseMiddleware.exposeErrorDiagnostics()
          ? { stack: err.stack, extras: err.extras }
          : {}),
      },
      correlationId,
    });
  }

  // Handle 401 Unauthorized
  if (err.status === 401) {
    return res.status(401).json({
      success: false,
      error: {
        message: "Unauthorized",
        code: "UNAUTHORIZED",
        status: 401,
      },
      correlationId,
    });
  }

  // Handle 403 Forbidden
  if (err.status === 403) {
    return res.status(403).json({
      success: false,
      error: {
        message: "Forbidden",
        code: "FORBIDDEN",
        status: 403,
      },
      correlationId,
    });
  }

  // Handle 404 Not Found
  if (err.status === 404) {
    return res.status(404).json({
      success: false,
      error: {
        message: "Not Found",
        code: "NOT_FOUND",
        status: 404,
      },
      correlationId,
    });
  }

  // Handle validation errors
  if (err.isJoi) {
    return res.status(400).json({
      success: false,
      error: {
        message: "Validation Error",
        code: "VALIDATION_ERROR",
        status: 400,
        details: err.details.map((d) => d.message),
      },
      correlationId,
    });
  }

  // Handle other errors
  const isProduction = process.env.NODE_ENV === "production";
  console.log("ERROR:", err.message || "Internal Server Error");
  if (!isProduction) {
    console.log("STACK:", err.stack);
  }

  // Phase 1C-2S: raw message and stack only when NODE_ENV === "development" (logging above unchanged).
  const exposeDiagnostics = responseMiddleware.exposeErrorDiagnostics();
  res.status(500).json({
    success: false,
    error: {
      message: exposeDiagnostics ? err.message : "Internal Server Error",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      ...(exposeDiagnostics ? { stack: err.stack } : {}),
    },
    correlationId,
  });
});

process.on("SIGINT", async () => {
  process.exit(0);
});

module.exports = app;
