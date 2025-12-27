const B2CUsersHandler = require("../handlers/b2c.users.handler");
const jwtHelper = require("../helpers/jwt");
const { encryptToken } = require("../helpers/tokenEncryption");
const { AppError } = require("../errors/AppError");

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
    const { code, codeVerifier } = req.body;

    if (!code || !codeVerifier) {
      return next(
        AppError.badRequest("Authorization code and codeVerifier are required")
      );
    }

    const { user, tokens } = await B2CUsersHandler.handleB2CAuth(
      code,
      codeVerifier
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
    return next(
      AppError.internalServerError("Microsoft authentication failed")
    );
  }
};
