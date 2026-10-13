/**
 * Phase 1 auth hardening:
 *  - PKCE code verifier comes from crypto.randomBytes (never Math.random) and stays valid RFC 7636
 *    input (128 chars, unreserved alphabet, S256 challenge = base64url(sha256(verifier))).
 *  - Entra (CRM) sign-in has no built-in configuration fallbacks: missing settings fail closed,
 *    while B2C portal URLs keep working.
 */
const crypto = require("crypto");

jest.mock("../handlers/azure.ad.handler", () => ({ handleAzureADAuth: jest.fn() }));
jest.mock("../helpers/loginTenantContext", () => {
  class LoginTenantError extends Error {}
  return {
    LoginTenantError,
    resolveLoginTenant: jest.fn(async () => ({ tenantId: "aaaaaaaaaaaaaaaaaaaaaaaa", connectionId: "conn" })),
  };
});

const { generatePKCE, getLogoutUrls, _generateCodeVerifier } = require("../controllers/pkce.controller");
const { handleAzureADCallback } = require("../controllers/azure.ad.controller");
const AzureADHandler = require("../handlers/azure.ad.handler");
const store = require("../helpers/pkceStateStore");

const ENTRA_VARS = ["AZURE_AD_TENANT_ID", "AZURE_AD_CLIENT_ID", "AZURE_AD_CLIENT_SECRET", "AZURE_AD_REDIRECT_URI"];
const res = () => {
  const r = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};
async function run(handler, req) {
  const r = res();
  const next = jest.fn();
  await handler(req, r, next);
  return { body: r.json.mock.calls[0]?.[0], err: next.mock.calls[0]?.[0] };
}
function withoutEnv(names, fn) {
  return async () => {
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    names.forEach((n) => delete process.env[n]);
    try {
      await fn();
    } finally {
      Object.entries(saved).forEach(([n, v]) => (process.env[n] = v));
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("PKCE code verifier", () => {
  test("generated from crypto.randomBytes, never Math.random", () => {
    const rb = jest.spyOn(crypto, "randomBytes");
    const mr = jest.spyOn(Math, "random");
    _generateCodeVerifier();
    expect(rb).toHaveBeenCalledWith(96);
    expect(mr).not.toHaveBeenCalled();
  });

  test("valid RFC 7636 verifier: 128 chars of the unreserved alphabet", () => {
    for (let i = 0; i < 50; i++) {
      expect(_generateCodeVerifier()).toMatch(/^[A-Za-z0-9\-._~]{128}$/);
    }
  });

  test("distinct per call", () => {
    const set = new Set(Array.from({ length: 200 }, () => _generateCodeVerifier()));
    expect(set.size).toBe(200);
  });

  test("/pkce/generate: S256 challenge matches the returned verifier, in every authorize URL", async () => {
    const mr = jest.spyOn(Math, "random");
    const { body } = await run(generatePKCE, { query: {} });
    expect(mr).not.toHaveBeenCalled();
    expect(body.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{128}$/);
    const expected = crypto.createHash("sha256").update(body.codeVerifier).digest("base64url");
    expect(body.codeChallenge).toBe(expected);
    expect(body.codeChallengeMethod).toBe("S256");
    for (const url of Object.values(body.authorizationUrls)) {
      expect(new URL(url).searchParams.get("code_challenge")).toBe(expected);
    }
  });
});

describe("Entra configuration fails closed (no built-in fallbacks)", () => {
  test("configured: the CRM authorize URL uses exactly the configured values", async () => {
    const { body } = await run(generatePKCE, { query: {} });
    const url = new URL(body.authorizationUrls.azureAD);
    expect(url.pathname).toBe(`/${process.env.AZURE_AD_TENANT_ID}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get("client_id")).toBe(process.env.AZURE_AD_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(process.env.AZURE_AD_REDIRECT_URI);
  });

  test.each(ENTRA_VARS)(
    "missing %s: no CRM authorize URL (no fallback directory/app), B2C portal URLs unaffected",
    (name) =>
      withoutEnv([name], async () => {
        const { body, err } = await run(generatePKCE, { query: {} });
        expect(err).toBeUndefined();
        expect(body.authorizationUrls.azureAD).toBeNull();
        expect(body.authorizationUrls.azureB2C).toMatch(/^https:\/\//);
        expect(JSON.stringify(body)).not.toMatch(/39866a06|ad25f823/);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining(name));
      })()
  );

  test("missing configuration + ?tenant: the tenant-scoped CRM login is refused clearly", () =>
    withoutEnv(["AZURE_AD_CLIENT_ID"], async () => {
      const { err } = await run(generatePKCE, { query: { tenant: "DEVTENANTB" } });
      expect(err).toMatchObject({ status: 500, message: "Microsoft sign-in is not configured" });
    })());

  test("missing configuration: no Entra logout URL, B2C logout URL still returned", () =>
    withoutEnv(["AZURE_AD_TENANT_ID"], async () => {
      const { body } = await run(getLogoutUrls, { query: {} });
      expect(body.azureADLogoutUrl).toBeNull();
      expect(body.b2cLogoutUrl).toMatch(/^https:\/\//);
    })());

  test("missing configuration: the CRM callback fails with a clear 500 before any Microsoft call", () =>
    withoutEnv(["AZURE_AD_CLIENT_SECRET"], async () => {
      const { EntraConfigError } = require("../helpers/entraConfig");
      AzureADHandler.handleAzureADAuth.mockRejectedValueOnce(new EntraConfigError(["AZURE_AD_CLIENT_SECRET"]));
      store.rememberNonceForState("cfg-state", "n1");
      const { err } = await run(handleAzureADCallback, { body: { code: "c", codeVerifier: "v", state: "cfg-state" }, headers: {}, query: {} });
      expect(err).toMatchObject({ status: 500, message: "Microsoft sign-in is not configured" });
      // the variable NAME may be logged, never a value
      expect(JSON.stringify(console.error.mock.calls)).toMatch(/AZURE_AD_CLIENT_SECRET/);
      expect(JSON.stringify(console.error.mock.calls)).not.toMatch(/test-client-secret/);
    })());

  test("an empty/whitespace value counts as missing", () => {
    const { getEntraConfig } = require("../helpers/entraConfig");
    const saved = process.env.AZURE_AD_REDIRECT_URI;
    process.env.AZURE_AD_REDIRECT_URI = "   ";
    try {
      expect(() => getEntraConfig()).toThrow(/AZURE_AD_REDIRECT_URI/);
    } finally {
      process.env.AZURE_AD_REDIRECT_URI = saved;
    }
  });
});
