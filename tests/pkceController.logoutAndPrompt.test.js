/**
 * controllers/pkce.controller.js - covers two pieces of the "logout doesn't clear the
 * Microsoft session" fix: generatePKCE's authorize URLs now carry `prompt=login` (so a
 * still-valid login.microsoftonline.com/*.b2clogin.com session cookie can't silently
 * re-authenticate the user without a credential prompt), and the new getLogoutUrls
 * endpoint that lets each frontend actually end that session cookie on logout.
 */
const { generatePKCE, getLogoutUrls } = require("../controllers/pkce.controller");

function mockReq(query = {}) {
  return { query };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("generatePKCE prompt=login", () => {
  test("azureAD authorize URL includes prompt=login", async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await generatePKCE(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    const azureADUrl = new URL(body.authorizationUrls.azureAD);
    expect(azureADUrl.searchParams.get("prompt")).toBe("login");
  });

  test("every B2C authorize URL includes prompt=login", async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await generatePKCE(req, res, next);

    const body = res.json.mock.calls[0][0];
    for (const [key, urlStr] of Object.entries(body.authorizationUrls)) {
      if (key === "azureAD") continue;
      const url = new URL(urlStr);
      expect(url.searchParams.get("prompt")).toBe("login");
    }
  });
});

describe("getLogoutUrls", () => {
  test("returns both an Azure AD and a B2C logout URL with post_logout_redirect_uri set", async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await getLogoutUrls(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);

    const azureADUrl = new URL(body.azureADLogoutUrl);
    expect(azureADUrl.hostname).toBe("login.microsoftonline.com");
    expect(azureADUrl.pathname).toMatch(/\/oauth2\/v2\.0\/logout$/);
    expect(azureADUrl.searchParams.get("post_logout_redirect_uri")).toBeTruthy();

    const b2cUrl = new URL(body.b2cLogoutUrl);
    expect(b2cUrl.hostname).toMatch(/\.b2clogin\.com$/);
    expect(b2cUrl.pathname).toMatch(/\/oauth2\/v2\.0\/logout$/);
    expect(b2cUrl.searchParams.get("post_logout_redirect_uri")).toBeTruthy();
  });

  test("post_logout_redirect_uri reuses each flow's existing (already-registered) login redirect_uri", async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await getLogoutUrls(req, res, next);

    const body = res.json.mock.calls[0][0];
    const azureADUrl = new URL(body.azureADLogoutUrl);
    const expectedAzureADRedirect =
      process.env.AZURE_AD_REDIRECT_URI || "http://localhost:3000/auth/azure-crm";
    expect(azureADUrl.searchParams.get("post_logout_redirect_uri")).toBe(
      expectedAzureADRedirect,
    );

    const b2cUrl = new URL(body.b2cLogoutUrl);
    const expectedB2CRedirect = process.env.MS_REDIRECT_URI || "http://localhost:3000";
    expect(b2cUrl.searchParams.get("post_logout_redirect_uri")).toBe(
      expectedB2CRedirect,
    );
  });

  test("no logoutHint: the Azure AD logout URL carries no logout_hint (unchanged behaviour)", async () => {
    const res = mockRes();
    await getLogoutUrls(mockReq(), res, jest.fn());
    const url = new URL(res.json.mock.calls[0][0].azureADLogoutUrl);
    expect(url.searchParams.has("logout_hint")).toBe(false);
  });

  test("a valid logoutHint is forwarded as Microsoft's logout_hint (Azure AD URL only)", async () => {
    const hint = "O.aX-yz_12+ab/cd==";
    const res = mockRes();
    await getLogoutUrls(mockReq({ logoutHint: hint }), res, jest.fn());
    const body = res.json.mock.calls[0][0];
    const url = new URL(body.azureADLogoutUrl);
    expect(url.searchParams.get("logout_hint")).toBe(hint);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBeTruthy();
    expect(new URL(body.b2cLogoutUrl).searchParams.has("logout_hint")).toBe(false);
  });

  test.each([
    ["a value with URL-structural characters", "abc&post_logout_redirect_uri=https://evil.example"],
    ["an over-long value", "a".repeat(2049)],
    ["an empty string", ""],
    ["a repeated query parameter (array)", ["a", "b"]],
  ])("drops %s rather than forwarding it", async (_label, logoutHint) => {
    const res = mockRes();
    await getLogoutUrls(mockReq({ logoutHint }), res, jest.fn());
    const url = new URL(res.json.mock.calls[0][0].azureADLogoutUrl);
    expect(url.searchParams.has("logout_hint")).toBe(false);
    expect([...url.searchParams.getAll("post_logout_redirect_uri")]).toHaveLength(1);
  });
});
