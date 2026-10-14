/**
 * Loggable fields of a Microsoft identity platform error response (token endpoint, Graph).
 * Explicit fields only: HTTP status, Microsoft's error code(s) and trace/correlation ids. The raw
 * response and error_description (free text) are never logged.
 */
function microsoftErrorFields(status, data) {
  const body = data && typeof data === "object" ? data : {};
  const graphError = body.error && typeof body.error === "object" ? body.error : null;
  return {
    status: Number.isInteger(status) ? status : null,
    error:
      typeof body.error === "string"
        ? body.error
        : typeof graphError?.code === "string"
          ? graphError.code
          : null,
    errorCodes: Array.isArray(body.error_codes)
      ? body.error_codes.filter((c) => Number.isInteger(c))
      : null,
    traceId: typeof body.trace_id === "string" ? body.trace_id : null,
    correlationId: typeof body.correlation_id === "string" ? body.correlation_id : null,
  };
}

/**
 * True when `error` is the Entra token-exchange failure built by AzureADHandler, whose message
 * embeds Microsoft's error_description and is therefore not logged.
 */
const isMicrosoftTokenError = (error) => Boolean(error && error.azureError);

module.exports = { microsoftErrorFields, isMicrosoftTokenError };
