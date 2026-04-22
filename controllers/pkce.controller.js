const crypto = require("crypto");
const { AppError } = require("../errors/AppError");
const {
  resolveB2CPolicy,
  b2cAuthorizationUrl,
  getDefaultPolicy,
  getSignInPolicy,
  getSignUpPolicy,
  getPasswordResetPolicy,
  getGmailCombinedPolicy,
} = require("../helpers/b2cPolicy");

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
        Math.floor(Math.random() * charset.length),
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

    const pkceQuery = { state, codeChallenge };
    let selectedPolicy;
    try {
      selectedPolicy = resolveB2CPolicy({
        flow: req.query.flow,
        policy: req.query.policy,
      });
    } catch (e) {
      return next(AppError.badRequest(e.message));
    }

    const b2cAuthUrl = b2cAuthorizationUrl(selectedPolicy, pkceQuery);
    const signInPolicy = getSignInPolicy();
    const signUpPolicy = getSignUpPolicy();
    const b2cAuthUrlSignIn = b2cAuthorizationUrl(signInPolicy, pkceQuery);
    const b2cAuthUrlSignUp = b2cAuthorizationUrl(signUpPolicy, pkceQuery);
    const passwordResetPolicy = getPasswordResetPolicy();
    const b2cAuthUrlPasswordReset = b2cAuthorizationUrl(
      passwordResetPolicy,
      pkceQuery,
    );

    const b2cPolicies = {
      default: getDefaultPolicy(),
      selected: selectedPolicy,
      signIn: signInPolicy,
      signUp: signUpPolicy,
      passwordReset: passwordResetPolicy,
    };
    const authorizationUrls = {
      azureAD: azureADAuthUrl,
      azureB2C: b2cAuthUrl,
      azureB2CSignIn: b2cAuthUrlSignIn,
      azureB2CSignUp: b2cAuthUrlSignUp,
      azureB2CPasswordReset: b2cAuthUrlPasswordReset,
    };

    if (process.env.MS_POLICY_GMAIL_COMBINED) {
      const gmailPolicy = getGmailCombinedPolicy();
      b2cPolicies.gmailCombined = gmailPolicy;
      authorizationUrls.azureB2CGmailCombined = b2cAuthorizationUrl(
        gmailPolicy,
        pkceQuery,
      );
    }

    res.json({
      success: true,
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: "S256",
      state,
      b2cPolicies,
      authorizationUrls,
      instructions: {
        step1:
          "Open the B2C URL for the journey. GET /pkce/generate?flow=signin|signup|gmail|password-reset or ?policy=B2C_1_YourFlow. Single Google button: set MS_POLICY_GMAIL_COMBINED and use flow=gmail (or that authorize URL) then POST with flow=gmail",
        step2: "Copy the 'code' parameter from the redirect URL",
        step3:
          "POST /auth/azure-portal with the same flow or policy you used to obtain the code (body: code, codeVerifier, and optionally flow or policy)",
        step4:
          "The token endpoint policy must match the user flow that issued the code, or you get AADB2C90088",
      },
    });
  } catch (error) {
    console.error("PKCE generation error:", error);
    return next(
      AppError.internalServerError("Failed to generate PKCE parameters"),
    );
  }
};
