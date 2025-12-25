var path = require("path");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

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

var app = express();

// Disable Express automatic ETag generation (304 responses)
// Note: /me endpoint has explicit ETag handling, this only affects other routes
app.set("etag", false);

/**
 * 🔎 TEMPORARY DEBUG – MUST BE FIRST
 * Confirms gateway headers actually arrive at the service
 * Using console.log instead of console.error to avoid Application Insights suppression
 */
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

app.use(responseMiddleware);

mongooseConnection();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "200mb" }));

// Logger middleware should be after body parsing to log request bodies
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

app.get("/", (req, res) => {
  // Check if this is an Azure B2C callback with authorization code
  if (req.query.code && req.query.state) {
    console.log("=== Azure B2C Callback at Root ===");
    console.log("Code received:", req.query.code.substring(0, 50) + "...");
    console.log("State:", req.query.state);
    console.log("Redirecting to /auth/azure-portal for proper handling");

    // Redirect to the proper auth endpoint
    return res.redirect(
      `/auth/azure-portal?code=${req.query.code}&state=${req.query.state}`
    );
  }

  // Regular homepage
  res.render("index", { title: "User Service" });
});

app.use("/", require("./routes/index"));

app.use(function (req, res, next) {
  next(createError(404));
});

// Enhanced error handler for AppError and other errors
app.use((err, req, res, next) => {
  const correlationId =
    req.correlationId || req.headers["x-correlation-id"] || crypto.randomUUID();

  // Handle AppError instances
  if (err.name === "AppError") {
    const isProduction = process.env.NODE_ENV === "production";

    return res.status(err.status).json({
      success: false,
      error: {
        message: err.message,
        code: err.code,
        status: err.status,
        ...(isProduction ? {} : { stack: err.stack, extras: err.extras }),
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

  res.status(500).json({
    success: false,
    error: {
      message: isProduction ? "Internal Server Error" : err.message,
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      ...(isProduction ? {} : { stack: err.stack }),
    },
    correlationId,
  });
});

// Initialize RabbitMQ event system (non-blocking, don't crash service if it fails)
const { initEventSystem, setupConsumers } = require("./rabbitMQ");

(async () => {
  try {
    await initEventSystem();
    await setupConsumers();
    console.log("✅ RabbitMQ event system initialized (user-service)");
  } catch (err) {
    console.error(
      "❌ Failed to initialize RabbitMQ event system:",
      err.message,
      err.stack
    );
    // Don't throw - allow service to continue without RabbitMQ
    // Service can still function, just without event publishing/consuming
  }
})().catch((err) => {
  console.error("❌ RabbitMQ initialization error (non-fatal):", err.message);
  // Swallow error to prevent service crash
});

process.on("SIGINT", async () => {
  process.exit(0);
});

module.exports = app;
