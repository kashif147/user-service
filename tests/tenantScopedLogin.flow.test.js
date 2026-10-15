/**
 * Tenant-scoped CRM sign-in across the OAuth round trip:
 *   GET /pkce/generate?tenant=<code>  -> tenant + Entra connection bound to the state server-side
 *   POST /auth/azure-crm {code, codeVerifier, state} -> the SAME context restored from the state
 *
 * Real controllers, real helpers/pkceStateStore.js and helpers/loginTenantContext.js; the Tenant
 * model is in memory and AzureADHandler.handleAzureADAuth is a spy (its tenant logic is covered by
 * azureAdHandler.tenantScopedLogin.test.js).
 */
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const DIR = process.env.AZURE_AD_TENANT_ID || "39866a06-30bc-4a89-80c6-9dd9357dd453";

const mockTenants = [];
jest.mock("../models/tenant.model", () => ({
  find: (q) => {
    const rows = mockTenants.filter(
      (t) => t.isActive !== false && q.$or.some((c) => (c.code && c.code === t.code) || (c._id && String(c._id) === t._id))
    );
    return { select: () => ({ lean: async () => JSON.parse(JSON.stringify(rows)) }) };
  },
}));
jest.mock("../handlers/azure.ad.handler");
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "signed.jwt" }) }));

const AzureADHandler = require("../handlers/azure.ad.handler");
const { generatePKCE } = require("../controllers/pkce.controller");
const { handleAzureADCallback } = require("../controllers/azure.ad.controller");
const store = require("../helpers/pkceStateStore");

const entra = (id, extra = {}) => ({ _id: id, connectionType: "Entra ID (Azure AD)", directoryId: DIR, isActive: true, ...extra });
const res = () => {
  const r = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};
async function start(query) {
  const r = res();
  const next = jest.fn();
  await generatePKCE({ query }, r, next);
  if (next.mock.calls.length) return { error: next.mock.calls[0][0] };
  const body = r.json.mock.calls[0][0];
  const url = new URL(body.authorizationUrls.azureAD);
  return { state: url.searchParams.get("state"), nonce: url.searchParams.get("nonce"), url };
}
async function callback(body, headers = {}) {
  const r = res();
  const next = jest.fn();
  await handleAzureADCallback({ body, headers, query: {} }, r, next);
  return { r, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTenants.length = 0;
  mockTenants.push(
    { _id: TENANT_A, code: "MULTIAUTH", isActive: true, authenticationConnections: [entra("connA")] },
    { _id: TENANT_B, code: "DEVTENANTB", isActive: true, authenticationConnections: [entra("connB")] },
    { _id: "dddddddddddddddddddddddd", code: "NOENTRA", isActive: true, authenticationConnections: [] },
  );
  AzureADHandler.handleAzureADAuth.mockResolvedValue({ user: { _id: "u", userEmail: "e", tokens: {} } });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("login transaction carries the ProjectShell tenant through the Microsoft round trip", () => {
  test("L1 ?tenant=DEVTENANTB: the callback restores DEVTENANTB + its connection from the state", async () => {
    const s = await start({ tenant: "devtenantb" });
    await callback({ code: "c", codeVerifier: "v", state: s.state });
    expect(AzureADHandler.handleAzureADAuth).toHaveBeenCalledWith("c", "v", s.nonce, { tenantId: TENANT_B, connectionId: "connB" });
  });

  test("L2 ?tenant=<Tenant._id> works the same as the code", async () => {
    const s = await start({ tenant: TENANT_A });
    await callback({ code: "c", codeVerifier: "v", state: s.state });
    expect(AzureADHandler.handleAzureADAuth.mock.calls[0][3]).toEqual({ tenantId: TENANT_A, connectionId: "connA" });
  });

  test("L3 tenantId in the callback body / query / x-tenant-id cannot replace the stored tenant", async () => {
    const s = await start({ tenant: "DEVTENANTB" });
    await callback(
      { code: "c", codeVerifier: "v", state: s.state, tenantId: TENANT_A, tenant: "MULTIAUTH", connectionId: "connA" },
      { "x-tenant-id": TENANT_A }
    );
    expect(AzureADHandler.handleAzureADAuth.mock.calls[0][3]).toEqual({ tenantId: TENANT_B, connectionId: "connB" });
  });

  test("L4 the state is single-use: a replay is refused before any token exchange", async () => {
    const s = await start({ tenant: "DEVTENANTB" });
    await callback({ code: "c", codeVerifier: "v", state: s.state });
    const replay = await callback({ code: "c", codeVerifier: "v", state: s.state });
    expect(replay.next.mock.calls[0][0]).toMatchObject({ status: 400 });
    expect(AzureADHandler.handleAzureADAuth).toHaveBeenCalledTimes(1);
  });

  test("L5 a guessed/foreign state is refused", async () => {
    const out = await callback({ code: "c", codeVerifier: "v", state: "made-up-state" });
    expect(out.next.mock.calls[0][0]).toMatchObject({ status: 400 });
    expect(AzureADHandler.handleAzureADAuth).not.toHaveBeenCalled();
  });

  test("L6 states are unpredictable (crypto random, distinct per login)", async () => {
    const states = new Set();
    for (let i = 0; i < 20; i++) states.add((await start({ tenant: "DEVTENANTB" })).state);
    expect(states.size).toBe(20);
    for (const s of states) expect(s.length).toBeGreaterThanOrEqual(16);
  });

  test("L7 the tenant never appears in the Microsoft authorize URL (it lives server-side only)", async () => {
    const s = await start({ tenant: "DEVTENANTB" });
    expect(s.url.toString()).not.toMatch(/DEVTENANTB|cccccccccccccccccccccccc/i);
  });

  test("L8 no ?tenant: legacy login, callback passes no context (directory-wide fallback)", async () => {
    const s = await start({});
    await callback({ code: "c", codeVerifier: "v", state: s.state, tenantId: TENANT_B });
    expect(AzureADHandler.handleAzureADAuth.mock.calls[0][3]).toBeNull();
  });
});

describe("starting a tenant-scoped login", () => {
  test.each([
    ["unknown tenant", "NOPE"],
    ["tenant without an Entra connection", "NOENTRA"],
    ["malformed selector", "{$ne:1}"],
    ["empty selector", ""],
  ])("S %s -> the same generic 400, no state issued", async (_d, tenant) => {
    const out = await start({ tenant });
    expect(out.error).toMatchObject({ status: 400, message: "Microsoft sign-in is not available for this organisation" });
  });

  test("S inactive Entra connection -> 400", async () => {
    mockTenants[1].authenticationConnections = [entra("connB", { isActive: false })];
    expect((await start({ tenant: "DEVTENANTB" })).error).toMatchObject({ status: 400 });
  });

  test("S Entra connection for a different directory -> 400", async () => {
    mockTenants[1].authenticationConnections = [entra("connB", { directoryId: "another-directory" })];
    expect((await start({ tenant: "DEVTENANTB" })).error).toMatchObject({ status: 400 });
  });
});
