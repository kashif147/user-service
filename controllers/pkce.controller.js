const crypto = require("crypto");
const { AppError } = require("../errors/AppError");

/**
 * Generate PKCE parameters for Azure AD authentication
 */
module.exports.generatePKCE = async (req, res, next) => {
  try {
    // Generate code verifier (128 characters)
    const charset =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let codeVerifier = "";

    for (let i = 0; i < 128; i++) {
      codeVerifier += charset.charAt(
        Math.floor(Math.random() * charset.length)
      );
    }

    // Generate code challenge using SHA256
    const hash = crypto.createHash("sha256").update(codeVerifier).digest();
    const codeChallenge = hash
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    // Generate authorization URLs with real values
    const tenantId =
      process.env.AZURE_AD_TENANT_ID || "39866a06-30bc-4a89-80c6-9dd9357dd453";
    const clientId =
      process.env.AZURE_AD_CLIENT_ID || "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae";
    const redirectUri =
      process.env.AZURE_AD_REDIRECT_URI ||
      "http://localhost:3000/auth/azure-crm";
    const scope = "openid profile email offline_access";
    const state = Math.random().toString(36).substring(7);

    const azureADAuthUrl =
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
      `client_id=${clientId}&` +
      `response_type=code&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}&` +
      `state=${state}&` +
      `code_challenge=${codeChallenge}&` +
      `code_challenge_method=S256`;

    // B2C authorization URL
    const b2cTenantId = process.env.MS_TENANT_NAME || "projectshellAB2C";
    const policy = process.env.MS_POLICY || "B2C_1_projectshell";
    const b2cClientId =
      process.env.MS_CLIENT_ID || "e3688a2f-3956-42f9-8c98-6fea7a60a5b4";
    const b2cRedirectUri =
      process.env.MS_REDIRECT_URI || "http://localhost:3000";

    const b2cAuthUrl =
      `https://${b2cTenantId}.b2clogin.com/${b2cTenantId}.onmicrosoft.com/${policy}/oauth2/v2.0/authorize?` +
      `client_id=${b2cClientId}&` +
      `response_type=code&` +
      `redirect_uri=${encodeURIComponent(b2cRedirectUri)}&` +
      `scope=${encodeURIComponent("openid offline_access")}&` +
      `state=${state}&` +
      `code_challenge=${codeChallenge}&` +
      `code_challenge_method=S256`;

    res.json({
      success: true,
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: "S256",
      state,
      authorizationUrls: {
        azureAD: azureADAuthUrl,
        azureB2C: b2cAuthUrl,
      },
      instructions: {
        step1:
          "Use the authorization URL to authenticate with Azure AD or Azure B2C",
        step2: "Copy the 'code' parameter from the redirect URL",
        step3:
          "Use the code and codeVerifier in your token exchange request. The response will include an 'accessToken' field containing the Bearer token for API authentication (works for both Azure AD and Azure B2C)",
        step4: "Send POST request to /auth/azure-portal or /auth/azure-b2c",
      },
    });
  } catch (error) {
    console.error("PKCE generation error:", error);
    return next(
      AppError.internalServerError("Failed to generate PKCE parameters")
    );
  }
};
