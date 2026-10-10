const { AppError } = require("../errors/AppError");

// Phase 1C-2S: stack traces and error extras are diagnostics for local development only.
// Explicit allow-list — staging, production, test and an unset NODE_ENV all get the safe response.
const exposeErrorDiagnostics = () => process.env.NODE_ENV === "development";

module.exports = (req, res, next) => {
  // Success response helper
  res.success = (data) => {
    res.status(200).json({ status: "success", data });
  };

  // Helper methods for AppError pattern
  res.sendAppError = (appError) => {
    const correlationId =
      req.correlationId ||
      req.headers["x-correlation-id"] ||
      require("crypto").randomUUID();

    res.status(appError.status).json({
      success: false,
      error: {
        message: appError.message,
        code: appError.code,
        status: appError.status,
        ...(exposeErrorDiagnostics()
          ? { stack: appError.stack, extras: appError.extras }
          : {}),
      },
      correlationId,
    });
  };

  res.sendBadRequest = (message, extras = {}) => {
    const error = AppError.badRequest(message, extras);
    res.sendAppError(error);
  };

  res.sendUnauthorized = (message, extras = {}) => {
    const error = AppError.unauthorized(message, extras);
    res.sendAppError(error);
  };

  res.sendForbidden = (message, extras = {}) => {
    const error = AppError.forbidden(message, extras);
    res.sendAppError(error);
  };

  res.sendNotFound = (message, extras = {}) => {
    const error = AppError.notFound(message, extras);
    res.sendAppError(error);
  };

  res.sendConflict = (message, extras = {}) => {
    const error = AppError.conflict(message, extras);
    res.sendAppError(error);
  };

  res.sendInternalError = (message, extras = {}) => {
    const error = AppError.internalServerError(message, extras);
    res.sendAppError(error);
  };

  // Standardized not found responses (200 OK instead of 404)
  res.notFoundList = (message = "No records found") => {
    res.status(200).json({
      success: true,
      data: [],
      message,
    });
  };

  res.notFoundRecord = (message = "Record not found") => {
    res.status(200).json({
      success: true,
      data: null,
      message,
    });
  };

  next();
};

module.exports.exposeErrorDiagnostics = exposeErrorDiagnostics;
