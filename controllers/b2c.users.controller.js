const B2CUsersHandler = require("../handlers/b2c.users.handler");
const jwtHelper = require("../helpers/jwt");
const { encryptToken } = require("../helpers/tokenEncryption");
const { AppError } = require("../errors/AppError");
const {
  takePolicyForState,
  takeNonceForState,
} = require("../helpers/pkceStateStore");

function getFrontendBaseUrl() {
  if (!process.env.MS_REDIRECT_URI) {
    throw new Error("MS_REDIRECT_URI is not configured");
  }
  return new URL(process.env.MS_REDIRECT_URI).origin;
}

/**
 * Azure B2C GET redirect handler
 * Browser → redirect
 * Mobile/API → JSON only
 */
module.exports.handleMicrosoftRedirect = async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    const isApiClient =
      req.headers.accept?.includes("application/json") ||
      req.headers["x-client-type"] === "mobile" ||
      req.headers["user-agent"]?.includes("ReactNative") ||
      req.headers["user-agent"]?.includes("okhttp");

    const frontendBaseUrl = getFrontendBaseUrl();

    // Azure error
    if (error) {
      if (isApiClient) {
        return res.status(400).json({ success: false, error });
      }
      return res.redirect(
        `${frontendBaseUrl}/b2c-test.html?error=${encodeURIComponent(error)}`
      );
    }

    // Missing code
    if (!code) {
      if (isApiClient) {
        return res.status(400).json({
          success: false,
          error: "No authorization code received",
        });
      }
      return res.redirect(
        `${frontendBaseUrl}/b2c-test.html?error=No%20authorization%20code`
      );
    }

    // Browser flow
    if (!isApiClient) {
      return res.redirect(
        `${frontendBaseUrl}/b2c-test.html?code=${code}&state=${state || ""}`
      );
    }

    // Mobile / API flow (NO redirect)
    return res.status(200).json({
      success: true,
      code,
      state,
    });
  } catch (error) {
    console.error("Azure B2C Redirect Error:", error);
    return next(AppError.internalServerError("Azure B2C redirect failed"));
  }
};

/**
 * Azure B2C POST callback
 * Used by mobile + SPA
 */
module.exports.handleMicrosoftCallback = async (req, res, next) => {
  try {
    const { code, codeVerifier, state } = req.body;

    if (!code || !codeVerifier) {
      return next(
        AppError.badRequest("Authorization code and codeVerifier are required")
      );
    }

    // `state` must be the value returned by GET /pkce/generate for the authorize URL that
    // was actually used, so the nonce generated for that request can be recovered and
    // checked against the ID token's `nonce` claim. Required, not optional: without it
    // there is no way to detect a replayed ID token.
    if (!state) {
      return next(AppError.badRequest("state is required"));
    }
    const expectedNonce = takeNonceForState(state);
    if (!expectedNonce) {
      return next(
        AppError.badRequest("Unknown or expired state; restart the login flow")
      );
    }

    // `state` is mandatory (checked above) and pkce.controller.js always records the
    // policy it used for every state it issues, alongside that state's nonce. The
    // state->policy mapping is the SOLE authoritative source for policyName - no
    // client-supplied `policy`/`flow` field is consulted here. A client-supplied override
    // previously took priority over this state binding, which meant a caller's own
    // `req.body.policy` could flow into decodeIdToken's JWKS selection and `tfp`/`acr`
    // comparison instead of the policy this server actually used to build the authorize
    // URL and nonce. decodeIdToken's exact-match check against the token's real policy
    // claim already failed closed on a mismatch, so this was not an active bypass - but it
    // contradicted the trust model. If the state entry is missing/expired/consumed, fail
    // closed and require the login flow to restart rather than falling back to anything
    // client-supplied.
    const policyName = takePolicyForState(state);
    if (!policyName) {
      return next(
        AppError.badRequest(
          "Unknown or expired authentication state; restart the login flow",
        ),
      );
    }

    console.log("B2C /auth/azure-portal", {
      resolvedPolicy: policyName,
      usedStateBinding: true,
    });

    const { user, tokens } = await B2CUsersHandler.handleB2CAuth(
      code,
      codeVerifier,
      policyName,
      expectedNonce,
    );

    const tokenData = await jwtHelper.generateToken(user);
    const encryptedToken = encryptToken(tokenData.token);

    return res.status(200).json({
      success: true,
      message: "Microsoft authentication successful",
      user: {
        id: user._id,
        userEmail: user.userEmail,
        userFirstName: user.userFirstName,
        userLastName: user.userLastName,
        userFullName: user.userFullName,
        userMobilePhone: user.userMobilePhone,
        userMemberNumber: user.userMemberNumber,
        userMicrosoftId: user.userMicrosoftId,
        userAuthProvider: user.userAuthProvider,
        userType: user.userType,
        userLastLogin: user.userLastLogin,
      },
      accessToken: encryptedToken,
      refreshToken: tokens.refresh_token,
    });
  } catch (error) {
    console.error("Microsoft Auth Error:", error);
    const oauthDetail =
      error.response?.data?.error_description || error.response?.data?.error;
    const detailStr = String(oauthDetail || "");
    if (
      detailStr.includes("AADB2C90088") ||
      (error.response?.data?.error === "invalid_grant" &&
        detailStr.includes("not been issued for this endpoint"))
    ) {
      return next(
        AppError.badRequest(
          "B2C user flow mismatch: the token endpoint used a different policy than the one that issued the code. " +
            "Use the same `flow` or `policy` in POST as for GET /pkce/generate (e.g. flow=gmail, flow=signup, or policy=...). " +
            "If the app sends two POSTs (e.g. React StrictMode), the second can fail: dedupe the callback.",
          {
            code: "B2C_POLICY_MISMATCH",
            extras:
              process.env.NODE_ENV !== "production"
                ? { oauth: error.response?.data }
                : undefined,
          },
        ),
      );
    }
    // ID token failed cryptographic/claim verification (bad signature, wrong issuer,
    // wrong audience, wrong policy, nonce mismatch, expired, not-yet-valid, unsupported
    // algorithm - anything jose's jwtVerify or the explicit tfp/nonce checks reject).
    // Surface as 401, not 500: this is an authentication failure, not a server error.
    const isTokenVerificationFailure =
      error.message.includes("nonce") ||
      error.message.includes("policy") ||
      error.message.includes("directory") ||
      error.message.includes("missing expected nonce") ||
      error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" ||
      error.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
      error.code === "ERR_JWT_EXPIRED" ||
      error.code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
      error.code === "ERR_JWKS_NO_MATCHING_KEY";
    if (isTokenVerificationFailure) {
      console.error("B2C ID token verification failed:", error.code || error.message);
      return next(AppError.unauthorized("Microsoft authentication failed"));
    }

    const devExtras =
      process.env.NODE_ENV !== "production"
        ? {
            extras: {
              details: oauthDetail || error.message,
              oauth: error.response?.data,
            },
          }
        : {};
    return next(
      AppError.internalServerError(
        "Microsoft authentication failed",
        devExtras,
      ),
    );
  }
};
