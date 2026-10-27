/**
 * Phase B / Z1 - the CRM sign-in callback and the platform claim.
 *
 * The claim decision uses only the handler's verified identity: a `plat`/platform field in the body,
 * query or headers never produces one, and off mode signs exactly as before (generateToken(user)).
 * Portal (B2C) sign-in never reaches resolvePlatformClaim.
 */
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const TENANT_A = "68cbf7806080b4621d469d34";
const PID = "6a0000000000000000000a01";

jest.mock("../models/tenant.model", () => ({
  findOne: () => ({ select: () => ({ lean: async () => ({ _id: TENANT_A, code: "MULTIAUTH", name: "Digital Informatics", isActive: true }) }) }),
}));
jest.mock("../handlers/azure.ad.handler", () => ({ handleAzureADAuth: jest.fn() }));
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "signed.projectshell.jwt" }) }));
jest.mock("../helpers/pkceStateStore", () => ({ takeLoginTransaction: jest.fn() }));

const fs = require("fs");
const path = require("path");
const AzureADHandler = require("../handlers/azure.ad.handler");
const jwtHelper = require("../helpers/jwt");
const { takeLoginTransaction } = require("../helpers/pkceStateStore");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const { handleAzureADCallback } = require("../controllers/azure.ad.controller");

const user = { _id: "u1", tenantId: TENANT_A, userEmail: "staff@example.org", userType: "CRM", userMicrosoftId: OID };
const verifiedIdentity = { issuer: `https://login.microsoftonline.com/${DIR}/v2.0`, oid: OID, tid: DIR, amr: null };

async function callback(req = {}) {
  takeLoginTransaction.mockReturnValue({ nonce: "n1", loginContext: { tenantId: TENANT_A, connectionId: "connA" } });
  AzureADHandler.handleAzureADAuth.mockResolvedValue({ user, tokens: {}, verifiedIdentity });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await handleAzureADCallback(
    { body: { code: "c", codeVerifier: "v", state: "s1", ...(req.body || {}) }, query: req.query || {}, headers: req.headers || {} },
    res, jest.fn(),
  );
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}
const lookup = (result) => jest.spyOn(PlatformPrincipal, "findOne").mockImplementation(() => ({ select: () => ({ lean: async () => result }) }));

beforeEach(() => {
  jest.clearAllMocks();
  for (const m of ["log", "warn", "error", "info"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.PLATFORM_AUTH_MODE; });

test("off (default): no lookup; generateToken(user) exactly as before Z1", async () => {
  const spy = lookup({ _id: PID, tid: DIR, status: "active", revision: 1, permissions: [] });
  const { status } = await callback();
  expect(status).toBe(200);
  expect(spy).not.toHaveBeenCalled();
  expect(jwtHelper.generateToken).toHaveBeenCalledWith(user);
  expect(jwtHelper.generateToken.mock.calls[0]).toHaveLength(1);
});

test("shadow + active principal: generateToken(user, { platformClaim }); response shape unchanged", async () => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  lookup({ _id: PID, tid: DIR, status: "active", revision: 2, permissions: ["platform:tenant:read:any"] });
  const { status, body } = await callback();
  expect(status).toBe(200);
  expect(jwtHelper.generateToken).toHaveBeenCalledWith(user, { platformClaim: { v: 1, pid: PID, rev: 2 } });
  expect(Object.keys(body).sort()).toEqual(["accessToken", "message", "organisation", "success", "user"]);
  expect(JSON.stringify(body)).not.toMatch(/plat|verifiedIdentity|oid/i);
});

test("shadow + no principal: forged body / query / header platform input is ignored", async () => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  lookup(null);
  await callback({
    body: { plat: { v: 1, pid: PID, rev: 1 }, platform: true, platformPermissions: ["platform:tenant:create"] },
    query: { plat: "1", platform: "true" },
    headers: { "x-platform-principal": PID, "x-platform-permissions": "[\"platform:tenant:create\"]", "x-platform-auth": "true" },
  });
  expect(jwtHelper.generateToken).toHaveBeenCalledWith(user);
  expect(jwtHelper.generateToken.mock.calls[0]).toHaveLength(1);
});

test("shadow + disabled principal: no claim", async () => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  lookup({ _id: PID, tid: DIR, status: "disabled", revision: 4, permissions: [] });
  await callback();
  expect(jwtHelper.generateToken).toHaveBeenCalledWith(user);
});

test("portal (B2C) and refresh paths never call the platform claim service", () => {
  for (const f of ["controllers/b2c.users.controller.js", "helpers/refreshToken.js", "handlers/b2c.users.handler.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    expect(src).not.toMatch(/platformClaim|resolvePlatformClaim|platformPrincipal/i);
  }
});
