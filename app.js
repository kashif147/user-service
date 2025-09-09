var path = require("path");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

var createError = require("http-errors");
var express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const swaggerSpecs = require("./config/swagger");

const { mongooseConnection } = require("./config/db");
const session = require("express-session");

const loggerMiddleware = require("./middlewares/logger.mw");
const responseMiddleware = require("./middlewares/response.mw");

var app = express();

app.use(responseMiddleware);

mongooseConnection();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "200mb" }));

app.use(loggerMiddleware);

app.use(cors());

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
    console.log("Redirecting to /auth/microsoft for proper handling");

    // Redirect to the proper auth endpoint
    return res.redirect(
      `/auth/microsoft?code=${req.query.code}&state=${req.query.state}`
    );
  }

  // Regular homepage
  res.render("index", { title: "User Service" });
});

app.use("/", require("./routes/index"));

app.use(function (req, res, next) {
  next(createError(404));
});

app.use((err, req, res, next) => {
  console.error(err.message || "Page Not Found");
  res.fail("Page Not Found");
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
