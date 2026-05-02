#!/usr/bin/env node

/**
 * Module dependencies.
 */

var app = require("../app");
var debug = require("debug")("user-service:server");
var http = require("http");
var { initEventSystem, setupConsumers } = require("../rabbitMQ");

/**
 * Get port from environment and store in Express.
 */

var port = normalizePort(process.env.PORT || "5001");

app.set("port", port);

/**
 * Create HTTP server.
 */

var server = http.createServer(app);

server.on("error", onError);
server.on("listening", onListening);

/**
 * RabbitMQ before listen so publishes (e.g. pricing.created.v1) are not skipped
 * while the client is still uninitialized.
 */
(async function startServer() {
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
    console.warn(
      "⚠️ Service will continue without RabbitMQ - events will not be published"
    );
  }

  server.listen(port, "0.0.0.0", () =>
    console.log(`Server Running on Port: ${port}`)
  );
})();

/**
 * Normalize a port into a number, string, or false.
 */

function normalizePort(val) {
  var port = parseInt(val, 10);

  if (isNaN(port)) {
    // named pipe
    return val;
  }

  if (port >= 0) {
    // port number
    return port;
  }

  return false;
}

/**
 * Event listener for HTTP server "error" event.
 */

function onError(error) {
  if (error.syscall !== "listen") {
    throw error;
  }

  var bind = typeof port === "string" ? "Pipe " + port : "Port " + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case "EACCES":
      console.error(bind + " requires elevated privileges");
      process.exit(1);
      break;
    case "EADDRINUSE":
      console.error(bind + " is already in use");
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */

function onListening() {
  var addr = server.address();
  var bind = typeof addr === "string" ? "pipe " + addr : "port " + addr.port;
  debug("Listening on " + bind);
}
