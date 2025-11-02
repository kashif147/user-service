var path = require("path");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

// Suppress Application Insights warnings if not configured
// Azure App Service auto-injects Application Insights, but warnings appear if key is missing
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING && process.env.APPLICATIONINSIGHTS_CONNECTION_STRING.trim() === "") {
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = undefined;
}
if (!process.env.APPINSIGHTS_INSTRUMENTATIONKEY || process.env.APPINSIGHTS_INSTRUMENTATIONKEY.trim() === "") {
  // Suppress Application Insights initialization if no key is set
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  
  console.warn = function(...args) {
    const message = args.join(" ");
    // Filter out Application Insights warnings about invalid instrumentation key
    if (message.includes("ApplicationInsights") && (message.includes("instrumentation key") || message.includes("iKey"))) {
      return; // Suppress this warning
    }
    originalConsoleWarn.apply(console, args);
  };
  
  console.error = function(...args) {
    const message = args.join(" ");
    // Filter out Application Insights errors about invalid instrumentation key
    if (message.includes("ApplicationInsights") && (message.includes("instrumentation key") || message.includes("iKey"))) {
      return; // Suppress this error
    }
    originalConsoleError.apply(console, args);
  };
  
  // Also suppress stderr output for Application Insights
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk, encoding, callback) {
    const message = chunk.toString();
    if (message.includes("ApplicationInsights") && (message.includes("instrumentation key") || message.includes("iKey"))) {
      return true; // Suppress
    }
    return originalStderrWrite(chunk, encoding, callback);
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

app.use(responseMiddleware);

mongooseConnection();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "200mb" }));

app.use(loggerMiddleware);

// Security middleware
app.use(securityHeaders);

// CORS middleware with enhanced configuration
app.use(handlePreflight);
app.use(corsMiddleware);
app.use(corsErrorHandler);

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
  console.error(err.message || "Internal Server Error");
  const isProduction = process.env.NODE_ENV === "production";

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

// const { connectRabbitMQ } = require("message-bus");

// (async () => {
//   await connectRabbitMQ({
//     amqpUrl: process.env.RABBITMQ_URL,
//     retryAttempts: 10, // Optional
//     retryDelay: 3000, // Optional
//   });

//   console.log("🎉 RabbitMQ is ready");
// })();

process.on("SIGINT", async () => {
  process.exit(0);
});

module.exports = app;
