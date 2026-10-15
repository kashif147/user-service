/**
 * The one response shape of an authentication connection (and of a tenant's
 * authenticationConnections). Only the allow-listed fields below leave the service, so nothing
 * stored on a connection now or later - and nothing from the server-side app registry (client id,
 * redirect URIs, scopes, secret references or values) - reaches a client unless it is added here.
 *
 * `effectiveAppRef` is the application the connection actually signs in through: its explicit
 * appRef, else the provider's compatibility default (helpers/authAppRegistry.js).
 */
const { effectiveAppRef } = require("./authAppRegistry");

const CONNECTION_RESPONSE_FIELDS = [
  "_id",
  "connectionType",
  "directoryId",
  "issuerUrl",
  "audience",
  "isActive",
  "autoProvisionUsers",
  "defaultRoleId",
  "appRef",
  "directoryOwnership",
  "connectedAt",
  "connectedBy",
  "lastTestedAt",
  "createdAt",
  "updatedAt",
];

const plain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v);

/** Allow-listed view of one stored connection. */
function toConnectionView(connection) {
  const c = plain(connection);
  if (!c || typeof c !== "object") return c;
  const out = {};
  for (const f of CONNECTION_RESPONSE_FIELDS) {
    if (c[f] !== undefined) out[f] = c[f];
  }
  if (c.lastTestResult && typeof c.lastTestResult === "object") {
    out.lastTestResult = { ok: c.lastTestResult.ok === true, code: c.lastTestResult.code ?? null };
  }
  out.effectiveAppRef = effectiveAppRef(c);
  return out;
}

/** A tenant document as returned to clients: unchanged except its connections are allow-listed. */
function toTenantView(tenant) {
  if (!tenant || typeof tenant !== "object") return tenant;
  const t = typeof tenant.toJSON === "function" ? tenant.toJSON() : { ...tenant };
  if (Array.isArray(t.authenticationConnections)) {
    t.authenticationConnections = t.authenticationConnections.map(toConnectionView);
  }
  return t;
}

module.exports = { CONNECTION_RESPONSE_FIELDS, toConnectionView, toTenantView };
