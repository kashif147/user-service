const AzureADHandler = require("../handlers/azure.ad.handler");
const jwtHelper = require("../helpers/jwt");

// Handle GET request from Azure redirect
module.exports.handleAzureADRedirect = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).json({
        success: false,
        message: "Azure AD authentication error",
        error: error,
      });
    }

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Authorization code is required",
      });
    }

    // For GET requests, we need to get the codeVerifier from session or return an error
    // Since PKCE requires the codeVerifier, we'll return an error asking for POST request
    return res.status(400).json({
      success: false,
      message: "Please use POST request with codeVerifier",
      code: code,
      state: state,
      instructions:
        "Send POST request to /auth/azure-crm with both 'code' and 'codeVerifier' in request body",
    });
  } catch (error) {
    console.error("Azure AD Redirect Error:", error);
    return res.status(500).json({
      success: false,
      message: "Authentication failed",
      error: error.message,
    });
  }
};

module.exports.handleAzureADCallback = async (req, res) => {
  try {
    const { code, codeVerifier } = req.body;

    if (!code || !codeVerifier) {
      return res.status(400).json({
        success: false,
        message: "Authorization code and codeVerifier are required",
      });
    }

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

    return res.status(200).json({
      success: true,
      message: "Azure AD authentication successful",
      user: userResponse,
      accessToken: tokenData.token, // This now includes roles and permissions
    });
  } catch (error) {
    console.error("Azure AD Auth Error:", error);
    return res.status(500).json({
      success: false,
      message: "Authentication failed",
      error: error.message,
    });
  }
};
