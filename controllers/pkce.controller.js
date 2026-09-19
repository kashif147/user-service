const crypto = require("crypto");
const { AppError } = require("../errors/AppError");
const {
  rememberStatePolicy,
  rememberNonceForState,
} = require("../helpers/pkceStateStore");
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
 * One OAuth `state` (+ its own `nonce`) per distinct B2C policy, registered for
 * POST /auth/azure-portal lookup. Same `code_verifier` / `code_challenge` for all; each
 * authorize URL must use the state for its policy or B2C will return a code this server
 * cannot map without `flow` in body. The nonce is stored alongside the state so the live
 * callback handler can verify the ID token's `nonce` claim instead of trusting an
 * unverified token blindly.
 */
function createStateForPolicies() {
  const byPolicy = new Map();
  return (policy) => {
    if (byPolicy.has(policy)) return byPolicy.get(policy);
    const s = crypto.randomBytes(12).toString("base64url");
    const nonce = crypto.randomBytes(16).toString("base64url");
    rememberStatePolicy(s, policy);
    rememberNonceForState(s, nonce);
    const result = { state: s, nonce };
    byPolicy.set(policy, result);
    return result;
  };
}

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
    // crypto.randomBytes, not Math.random(): this state doubles as the lookup key for the
    // nonce below, so it needs to be unguessable, not just unique.
    const azureADState = crypto.randomBytes(12).toString("base64url");
    const azureADNonce = crypto.randomBytes(16).toString("base64url");
    rememberNonceForState(azureADState, azureADNonce);

    const azureADAuthUrl =
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
      `client_id=${clientId}&` +
      `response_type=code&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}&` +
      `state=${azureADState}&` +
      `nonce=${azureADNonce}&` +
      `code_challenge=${codeChallenge}&` +
      `code_challenge_method=S256`;

    let selectedPolicy;
    try {
      selectedPolicy = resolveB2CPolicy({
        flow: req.query.flow,
        policy: req.query.policy,
      });
    } catch (e) {
      return next(AppError.badRequest(e.message));
    }

    const stateForPolicy = createStateForPolicies();
    const b2cSignIn = getSignInPolicy();
    const b2cSignUp = getSignUpPolicy();
    const passwordResetPolicy = getPasswordResetPolicy();

    const selectedStateNonce = stateForPolicy(selectedPolicy);
    const signInStateNonce = stateForPolicy(b2cSignIn);
    const signUpStateNonce = stateForPolicy(b2cSignUp);
    const passwordResetStateNonce = stateForPolicy(passwordResetPolicy);

    const b2cAuthUrl = b2cAuthorizationUrl(selectedPolicy, {
      state: selectedStateNonce.state,
      codeChallenge,
      nonce: selectedStateNonce.nonce,
    });
    const b2cAuthUrlSignIn = b2cAuthorizationUrl(b2cSignIn, {
      state: signInStateNonce.state,
      codeChallenge,
      nonce: signInStateNonce.nonce,
    });
    const b2cAuthUrlSignUp = b2cAuthorizationUrl(b2cSignUp, {
      state: signUpStateNonce.state,
      codeChallenge,
      nonce: signUpStateNonce.nonce,
    });
    const b2cAuthUrlPasswordReset = b2cAuthorizationUrl(passwordResetPolicy, {
      state: passwordResetStateNonce.state,
      codeChallenge,
      nonce: passwordResetStateNonce.nonce,
    });

    const b2cPolicies = {
      default: getDefaultPolicy(),
      selected: selectedPolicy,
      signIn: b2cSignIn,
      signUp: b2cSignUp,
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
      const gmailStateNonce = stateForPolicy(gmailPolicy);
      b2cPolicies.gmailCombined = gmailPolicy;
      authorizationUrls.azureB2CGmailCombined = b2cAuthorizationUrl(
        gmailPolicy,
        {
          state: gmailStateNonce.state,
          codeChallenge,
          nonce: gmailStateNonce.nonce,
        },
      );
    }

    // Only the state is returned to the client; the nonce stays server-side and is
    // recovered from the state on callback (see takeNonceForState in the auth handlers).
    const primaryB2CState = selectedStateNonce.state;

    res.json({
      success: true,
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: "S256",
      state: primaryB2CState,
      b2cPolicies,
      authorizationUrls,
      instructions: {
        step1:
          "Open ONE B2C URL from this response. Each URL uses a different `state` that maps to the correct user flow. GET ?flow=signin|signup|gmail|... selects the primary `authorizationUrls.azureB2C`",
        step2: "From the redirect, copy `code` and `state` (they match the user flow you used)",
        step3:
          "POST /auth/azure-portal: { code, codeVerifier, state } — `state` maps to the B2C policy; you can omit `flow`/`policy` if `state` is sent. Still valid to send `flow` or `policy` to override",
        step4:
          "AADB2C90088 means the wrong token policy was used; use `state` from the same redirect, or re-run PKCE and use one link only per login",
      },
    });
  } catch (error) {
    console.error("PKCE generation error:", error);
    return next(
      AppError.internalServerError("Failed to generate PKCE parameters"),
    );
  }
};
