/**
 * Phase 1C-2W — azure.ad.controller and tenantBranding.controller no longer return raw error text.
 *
 * - POST /auth/azure-crm (handleAzureADCallback): Azure error responses other than invalid_grant /
 *   invalid_client returned `Azure AD error: <error_description>` (AADSTS text, trace/correlation IDs),
 *   and unexpected errors returned the raw error.message. Both now return "Azure AD authentication
 *   failed" (500); the Azure response data / full error are still logged.
 * - POST /api/tenants/:id/branding/assets (uploadBrandingAsset): unexpected errors returned the raw
 *   error.message and nothing was logged. Now "Failed to upload branding asset" (500) + console.error.
 * All recognised / public responses (400 / 401 / invalid_client 500 / success) are unchanged.
 *
 * Mounts the REAL controller functions + response.mw + the app.js final handler (taken verbatim) under
 * NODE_ENV=staging; the Azure handler, JWT helper, PKCE store and blob service are stubs.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");

const MARK = "INTERNAL_MARKER redis://secret-host:6379 /srv/private/controller.js";
const PROV = "AZURE_PROVIDER_SECRET_DETAIL AADSTS9002313 Trace ID: 0000-SECRET-TRACE";
const mockMode = { v: null };
const mockAzErr = (data) => { const e = new Error("Request failed with status code 400"); e.response = { status: 400, data }; return e; };

jest.mock("../handlers/azure.ad.handler", () => ({
  handleAzureADAuth: async () => {
    const m = mockMode.v;
    if (m === "ok") return { user: { _id: "u1", userEmail: "a@x", tokens: {}, userType: "CRM" } };
    if (m === "invalid_grant") throw mockAzErr({ error: "invalid_grant", error_description: PROV });
    if (m === "invalid_client") throw mockAzErr({ error: "invalid_client", error_description: PROV });
    if (m === "provider_other") throw mockAzErr({ error: "server_error", error_description: PROV });
    if (m === "email") throw new Error("Email not found in Azure AD token");
    if (m === "tenant") throw new Error("Tenant ID not found in Azure AD token");
    if (m === "token") { const e = new Error("signature verification failed"); e.code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"; throw e; }
    throw new Error(MARK);
  },
}));
jest.mock("../helpers/jwt", () => ({ generateToken: async () => ({ token: "jwt.token.value" }) }));
jest.mock("../helpers/pkceStateStore", () => ({ takeNonceForState: () => "nonce-1" }));
jest.mock("../services/azure.blob.service", () => ({
  isConfigured: true,
  uploadToBlob: async () => { if (mockMode.v === "blob_fail") throw new Error(MARK); return "https://blob/x.png"; },
}));

const responseMiddleware = require("../middlewares/response.mw");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const hStart = appSrc.indexOf("app.use((err, req, res, next) => {");
const hEnd = appSrc.indexOf("\n});\n", hStart) + 4;
// eslint-disable-next-line no-new-func
const finalHandler = new Function("crypto", "responseMiddleware", `return (${appSrc.slice(hStart + "app.use(".length, hEnd - 1).trim().replace(/\)$/, "")});`)(crypto, responseMiddleware);
const AzureADController = require("../controllers/azure.ad.controller");
const TenantBrandingController = require("../controllers/tenantBranding.controller");

let server;
let port;
const unhandled = [];
const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
const ORIGINAL_ENV = process.env.NODE_ENV;
let errorLogs;
beforeAll(async () => {
  process.env.NODE_ENV = "staging";
  process.on("unhandledRejection", onUnhandled);
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.post("/auth/azure-crm", AzureADController.handleAzureADCallback);
  app.post("/api/tenants/:id/branding/assets", (req, res, next) => {
    if (req.query.nofile !== "1") req.file = { buffer: Buffer.from("img"), originalname: "logo.png", mimetype: "image/png" };
    next();
  }, TenantBrandingController.uploadBrandingAsset);
  app.use(finalHandler);
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
  process.off("unhandledRejection", onUnhandled);
  return new Promise((r) => server.close(r));
});
beforeEach(() => {
  mockMode.v = null;
  unhandled.length = 0;
  errorLogs = [];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation((...a) => errorLogs.push(a.map((x) => (x instanceof Error ? x.stack : typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")));
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  expect(unhandled).toEqual([]);
  jest.restoreAllMocks();
});

const post = (p, body) => new Promise((resolve) => {
  const d = JSON.stringify(body);
  const rq = http.request({ port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(d), "x-correlation-id": "cid-1" }, timeout: 3000 }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, raw: b, body: JSON.parse(b) }));
  });
  rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
  rq.end(d);
});
const msg = (r) => (r.body.error ? r.body.error.message : r.body.message);
const noLeak = (r) => expect(r.raw).not.toMatch(/INTERNAL_MARKER|secret-host|redis:\/\/|\/srv\/private|AZURE_PROVIDER_SECRET_DETAIL|AADSTS|SECRET-TRACE/);
const CB = { code: "c", codeVerifier: "v", state: "s", redirectUri: "https://crm/cb" };

describe("POST /auth/azure-crm (handleAzureADCallback)", () => {
  test("success unchanged", async () => {
    mockMode.v = "ok";
    const r = await post("/auth/azure-crm", CB);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, message: "Azure AD authentication successful", accessToken: "jwt.token.value" });
  });
  test.each([
    ["missing code", null, { codeVerifier: "v", state: "s" }, 400, "Authorization code and codeVerifier are required"],
    ["invalid_grant", "invalid_grant", CB, 400, "Invalid authorization code or code verifier"],
    ["invalid_client", "invalid_client", CB, 500, "Azure AD client configuration error"],
    ["Email not found", "email", CB, 400, "Email not found in Azure AD token"],
    ["Tenant ID not found", "tenant", CB, 400, "Tenant ID not found in Azure AD token"],
    ["ID token verification failure", "token", CB, 401, "Azure AD authentication failed"],
  ])("recognised: %s keeps its status/message", async (_l, mode, body, status, message) => {
    mockMode.v = mode;
    const r = await post("/auth/azure-crm", body);
    expect(r.status).toBe(status);
    expect(msg(r)).toBe(message);
    noLeak(r);
  });
  test("other Azure error response -> 500 generic, no error_description/trace IDs; Azure data still logged", async () => {
    mockMode.v = "provider_other";
    const r = await post("/auth/azure-crm", CB);
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({ message: "Azure AD authentication failed", code: "INTERNAL_SERVER_ERROR", status: 500 });
    noLeak(r);
    expect(errorLogs.some((l) => l.includes("AZURE_PROVIDER_SECRET_DETAIL"))).toBe(true);
  });
  test("unexpected error -> 500 generic, no raw text; full error still logged", async () => {
    mockMode.v = "internal";
    const r = await post("/auth/azure-crm", CB);
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({ message: "Azure AD authentication failed", code: "INTERNAL_SERVER_ERROR", status: 500 });
    noLeak(r);
    expect(errorLogs.some((l) => l.includes("INTERNAL_MARKER"))).toBe(true);
  });
});

describe("POST /api/tenants/:id/branding/assets (uploadBrandingAsset)", () => {
  test("success unchanged", async () => {
    const r = await post("/api/tenants/t1/branding/assets?assetType=logo", {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("success");
    expect(r.body.data).toMatchObject({ assetType: "logo", brandingField: "logoUrl", url: "https://blob/x.png" });
    expect(r.body.data.blobPath).toMatch(/^tenant-branding\/t1\/logo-[0-9a-f-]{36}\.png$/);
  });
  test.each([
    ["invalid assetType", "/api/tenants/t1/branding/assets?assetType=nope", "Invalid assetType. Use: logo, logoDark, favicon, letterHeader, letterFooter"],
    ["missing file", "/api/tenants/t1/branding/assets?assetType=logo&nofile=1", "Image file is required"],
  ])("recognised: %s keeps 400 and its message", async (_l, p, message) => {
    const r = await post(p, {});
    expect(r.status).toBe(400);
    expect(msg(r)).toBe(message);
  });
  test("upload failure -> 500 generic, no raw text; error now logged server-side", async () => {
    mockMode.v = "blob_fail";
    const r = await post("/api/tenants/t1/branding/assets?assetType=logo", {});
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({ message: "Failed to upload branding asset", code: "INTERNAL_SERVER_ERROR", status: 500 });
    noLeak(r);
    expect(errorLogs.some((l) => l.startsWith("[uploadBrandingAsset] upload failed:") && l.includes("INTERNAL_MARKER"))).toBe(true);
  });
});

test("route wiring unchanged", () => {
  const auth = fs.readFileSync(path.join(__dirname, "..", "routes", "auth.routes.js"), "utf8");
  expect(auth).toMatch(/router\.post\("\/azure-crm", azureADController\.handleAzureADCallback\)/);
  const tenant = fs.readFileSync(path.join(__dirname, "..", "routes", "tenant.routes.js"), "utf8");
  expect(tenant).toMatch(/requireTenantPathAccess\("id"\),\s*\n\s*defaultPolicyAdapter\.middleware\("tenant", "update"\),\s*\n\s*brandingAssetUploadMw,\s*\n\s*TenantBrandingController\.uploadBrandingAsset/);
});
