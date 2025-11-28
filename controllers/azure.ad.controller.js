const AzureADHandler = require("../handlers/azure.ad.handler");
const jwtHelper = require("../helpers/jwt");
const { encryptToken } = require("../helpers/tokenEncryption");
const { AppError } = require("../errors/AppError");

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
    const { code, codeVerifier } = req.body;

    if (!code || !codeVerifier) {
      return next(
        AppError.badRequest("Authorization code and codeVerifier are required")
      );
    }

    console.log("Processing Azure AD authentication...");
    const { user } = await AzureADHandler.handleAzureADAuth(code, codeVerifier);

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
    console.error("Azure AD authentication failed:", error.message);
    return next(AppError.internalServerError("Azure AD authentication failed"));
  }
};
