/**
 * Stage 5c-2 "Test Connection": a configuration / connectivity health check of one customer
 * directory for the shared CRM application. It proves only that
 *   A. the directory exists and resolves: its OpenID metadata names exactly that directory's
 *      issuer, authorize, token and key endpoints;
 *   B. the shared application has a service principal there and its credential is accepted: a
 *      client-credentials token for the application ITSELF ("{clientId}/.default").
 *
 * B deliberately asks for no Microsoft Graph or other API: the token carries no permissions and
 * nothing reads directory data. It is only checked for presence, then discarded - never decoded,
 * stored, returned or logged. Microsoft failures are classified from the structured `error_codes`
 * (never from text) into the safe result codes below; nothing Microsoft returns is passed on.
 */
const axios = require("axios");
const { getEntraCrmApp } = require("./authAppRegistry");
const { ENTRA_AUTHORITY_HOST } = require("./connectionAuthConfig");

const TEST_RESULT_CODES = Object.freeze([
  "CONNECTED",
  "DIRECTORY_NOT_FOUND",
  "DIRECTORY_NOT_CLAIMED",
  "APP_NOT_CONSENTED",
  "CREDENTIAL_INVALID",
  "MICROSOFT_UNAVAILABLE",
  "CONFIGURATION_INVALID",
]);

const MICROSOFT_TIMEOUT_MS = 10 * 1000;

// Microsoft identity platform error codes (AADSTS numbers in `error_codes`).
const DIRECTORY_NOT_FOUND_CODES = new Set([90002]); // directory (tenant) not found
const APP_NOT_CONSENTED_CODES = new Set([
  7000229, // application has no service principal in the directory
  700016, // application not found in the directory
  7000112, // application disabled in the directory
  65001, // consent not granted
  500011, // resource principal (the application itself) not found in the directory
]);
const CREDENTIAL_INVALID_CODES = new Set([
  7000215, // invalid client secret
  7000222, // expired client secret
  7000218, // client credential missing
]);

const fail = (code, step, httpStatus = null) => ({ ok: false, code, step, httpStatus });

function classifyMicrosoftFailure(response) {
  const codes = Array.isArray(response.data?.error_codes) ? response.data.error_codes.map(Number) : [];
  if (codes.some((c) => DIRECTORY_NOT_FOUND_CODES.has(c))) return "DIRECTORY_NOT_FOUND";
  if (codes.some((c) => APP_NOT_CONSENTED_CODES.has(c))) return "APP_NOT_CONSENTED";
  if (codes.some((c) => CREDENTIAL_INVALID_CODES.has(c))) return "CREDENTIAL_INVALID";
  if (response.status === 429 || response.status >= 500) return "MICROSOFT_UNAVAILABLE";
  return "CONFIGURATION_INVALID";
}

/**
 * @param {string} directoryId  normalised directory GUID, from the server-loaded connection
 * @returns {Promise<{ok: boolean, code: string, step: string, httpStatus: number|null}>}  never
 *   throws; `step` / `httpStatus` are for the server log only
 */
async function probeEntraDirectory(directoryId) {
  let app;
  try {
    app = getEntraCrmApp();
  } catch {
    return fail("CONFIGURATION_INVALID", "config");
  }
  if (!app.clientId || !app.clientSecret) return fail("CONFIGURATION_INVALID", "config");

  const base = `https://${ENTRA_AUTHORITY_HOST}/${directoryId}`;
  const http = { timeout: MICROSOFT_TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true };

  // A. The directory resolves to exactly its own metadata.
  let response;
  try {
    response = await axios.get(`${base}/v2.0/.well-known/openid-configuration`, http);
  } catch {
    return fail("MICROSOFT_UNAVAILABLE", "metadata"); // network / timeout: the error (and its config) is never logged
  }
  if (response.status !== 200) return fail(classifyMicrosoftFailure(response), "metadata", response.status);
  const m = response.data || {};
  if (
    m.issuer !== `${base}/v2.0` ||
    m.authorization_endpoint !== `${base}/oauth2/v2.0/authorize` ||
    m.token_endpoint !== `${base}/oauth2/v2.0/token` ||
    m.jwks_uri !== `${base}/discovery/v2.0/keys`
  ) {
    return fail("CONFIGURATION_INVALID", "metadata", response.status);
  }

  // B. The shared application exists in the directory and its credential is accepted. The token
  // endpoint is our own derived URL, never one taken from the metadata.
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: app.clientId,
    client_secret: app.clientSecret,
    scope: `${app.clientId}/.default`,
  });
  try {
    response = await axios.post(`${base}/oauth2/v2.0/token`, body.toString(), {
      ...http,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch {
    return fail("MICROSOFT_UNAVAILABLE", "token");
  }
  const tokenIssued = response.status === 200 && typeof response.data?.access_token === "string" && response.data.access_token !== "";
  const status = response.status;
  if (tokenIssued) {
    response = null; // the token is discarded here
    return { ok: true, code: "CONNECTED", step: "token", httpStatus: status };
  }
  if (status === 200) return fail("CONFIGURATION_INVALID", "token", status);
  return fail(classifyMicrosoftFailure(response), "token", status);
}

module.exports = { probeEntraDirectory, TEST_RESULT_CODES, MICROSOFT_TIMEOUT_MS };
