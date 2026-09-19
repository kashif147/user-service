const AzureADHandler = require("../handlers/azure.ad.handler");
const jwtHelper = require("../helpers/jwt");
const { encryptToken } = require("../helpers/tokenEncryption");
const { AppError } = require("../errors/AppError");
const { takeNonceForState } = require("../helpers/pkceStateStore");

// Handle GET request from Azure redirect
module.exports.handleAzureADRedirect = async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return next(AppError.badRequest("Azure AD authentication error"));
    }

    if (!code) {
      return next(AppError.badRequest("Authorization code is required"));
    }

    // Redirect back to the test page with the authorization code
    // The test page will automatically complete the authentication
    const redirectUrl = `http://localhost:3000/azure-ad-test.html?code=${encodeURIComponent(
      code
    )}&state=${encodeURIComponent(state)}`;
    return res.redirect(redirectUrl);
  } catch (error) {
    console.error("Azure AD Redirect Error:", error);
    return next(AppError.internalServerError("Azure AD redirect failed"));
  }
};

module.exports.handleAzureADCallback = async (req, res, next) => {
  try {
    const { code, codeVerifier, redirectUri, state } = req.body;

    if (!code || !codeVerifier) {
      return next(
        AppError.badRequest("Authorization code and codeVerifier are required")
      );
    }

    // `state` must be the value returned by GET /pkce (authorizationUrls.azureAD's own
    // `state` param) so the nonce this server generated for that authorize request can be
    // recovered and checked against the ID token's `nonce` claim. Required, not optional:
    // without it there is no way to detect a replayed ID token.
    if (!state) {
      return next(AppError.badRequest("state is required"));
    }
    const expectedNonce = takeNonceForState(state);
    if (!expectedNonce) {
      return next(
        AppError.badRequest("Unknown or expired state; restart the login flow")
      );
    }

    // Auto-detect redirect URI from request if not provided
    let finalRedirectUri = redirectUri;
    if (!finalRedirectUri) {
      const origin = req.headers.origin || req.headers.referer;
      if (origin) {
        try {
          const url = new URL(origin);
          finalRedirectUri = `${url.origin}/auth/azure-crm`;
          console.log(
            `Auto-detected redirect_uri from request: ${finalRedirectUri}`
          );
        } catch (e) {
          console.warn(`Failed to parse origin/referer: ${origin}`);
        }
      }
    }

    console.log("Processing Azure AD authentication...");
    console.log("Using redirect_uri:", finalRedirectUri || "default from env");
    const { user } = await AzureADHandler.handleAzureADAuth(
      code,
      codeVerifier,
      finalRedirectUri,
      expectedNonce
    );

    const issuedAtReadable = user.userIssuedAt
      ? new Date(user.userIssuedAt * 1000).toISOString()
      : null;
    const authTimeReadable = user.userAuthTime
      ? new Date(user.userAuthTime * 1000).toISOString()
      : null;
    const tokenVersionReadable = user.userTokenVersion || "Azure AD v2";

    // Use the new JWT helper that includes roles and permissions
    const tokenData = await jwtHelper.generateToken(user);

    const userResponse = {
      id: user._id,
      userEmail: user.userEmail,
      userFirstName: user.userFirstName,
      userLastName: user.userLastName,
      userFullName: user.userFullName,
      userMobilePhone: user.userMobilePhone,
      userMemberNumber: user.userMemberNumber,
      userMicrosoftId: user.userMicrosoftId,
      userAuthProvider: user.userAuthProvider,
      userSubject: user.userSubject,
      userAudience: user.userAudience,
      userIssuer: user.userIssuer,
      userIssuedAt: issuedAtReadable,
      userAuthTime: authTimeReadable,
      userTokenVersion: tokenVersionReadable,
      userPolicy: user.userPolicy,
      userLastLogin: user.userLastLogin,
      userType: user.userType,
      tokens: {
        id_token: user.tokens.id_token,
        refresh_token: user.tokens.refresh_token,
        id_token_expires_in: user.tokens.id_token_expires_in,
        refresh_token_expires_in: user.tokens.refresh_token_expires_in,
      },
    };

    console.log(`Azure AD authentication successful for: ${user.userEmail}`);

    // Encrypt the token before sending to frontend
    const encryptedToken = encryptToken(tokenData.token);

    return res.status(200).json({
      success: true,
      message: "Azure AD authentication successful",
      user: userResponse,
      accessToken: encryptedToken, // Encrypted token sent to frontend
    });
  } catch (error) {
    console.error("=== Azure AD Authentication Error ===");
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);

    // Handle Azure AD specific errors
    if (error.response) {
      console.error("Azure AD Response Status:", error.response.status);
      console.error(
        "Azure AD Response Data:",
        JSON.stringify(error.response.data, null, 2)
      );

      const azureError = error.response.data;
      if (azureError.error) {
        const errorMessage = azureError.error_description || azureError.error;
        if (azureError.error === "invalid_grant") {
          return next(
            AppError.badRequest("Invalid authorization code or code verifier")
          );
        }
        if (azureError.error === "invalid_client") {
          return next(
            AppError.internalServerError("Azure AD client configuration error")
          );
        }
        return next(
          AppError.internalServerError(`Azure AD error: ${errorMessage}`)
        );
      }
    }

    // Handle validation errors
    if (
      error.message.includes("Email not found") ||
      error.message.includes("Tenant ID not found")
    ) {
      return next(AppError.badRequest(error.message));
    }

    // ID token failed cryptographic/claim verification (bad signature, wrong issuer,
    // wrong audience, wrong tenant, nonce mismatch, expired, not-yet-valid, unsupported
    // algorithm - anything jose's jwtVerify or the explicit tid/nonce checks reject).
    // Surface as 401, not 500: this is an authentication failure, not a server error.
    const isTokenVerificationFailure =
      error.message.includes("nonce") ||
      error.message.includes("tenant mismatch") ||
      error.message.includes("missing expected nonce") ||
      error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" ||
      error.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
      error.code === "ERR_JWT_EXPIRED" ||
      error.code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
      error.code === "ERR_JWKS_NO_MATCHING_KEY";
    if (isTokenVerificationFailure) {
      console.error("Azure AD ID token verification failed:", error.code || error.message);
      return next(AppError.unauthorized("Azure AD authentication failed"));
    }

    // Log full error for debugging
    console.error(
      "Full error object:",
      JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
    );

    return next(
      AppError.internalServerError(
        error.message || "Azure AD authentication failed"
      )
    );
  }
};
