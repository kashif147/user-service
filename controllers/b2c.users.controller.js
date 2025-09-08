const B2CUsersHandler = require("../handlers/b2c.users.handler");
const jwtHelper = require("../helpers/jwt");
// const { emitMicrosoftAuthEvent } = require("../rabbitMQ/events/userEvents");

// Handle GET request from Azure B2C redirect
module.exports.handleMicrosoftRedirect = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).json({
        success: false,
        message: "Azure B2C authentication error",
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
        "Send POST request to /auth/azure-portal with both 'code' and 'codeVerifier' in request body",
    });
  } catch (error) {
    console.error("Azure B2C Redirect Error:", error);
    return res.status(500).json({
      success: false,
      message: "Authentication failed",
      error: error.message,
    });
  }
};

module.exports.handleMicrosoftCallback = async (req, res) => {
  try {
    const { code, codeVerifier } = req.body;
    if (!code || !codeVerifier) {
      return res.status(400).json({
        success: false,
        message: "Authorization code and codeVerifier are required",
      });
    }
    //
    const { user } = await B2CUsersHandler.handleB2CAuth(code, codeVerifier);

    const issuedAtReadable = user.userIssuedAt
      ? new Date(user.userIssuedAt * 1000).toISOString()
      : null;
    const authTimeReadable = user.userAuthTime
      ? new Date(user.userAuthTime * 1000).toISOString()
      : null;
    const tokenVersionReadable =
      user.userTokenVersion === "1.0"
        ? "Azure AD B2C v1"
        : user.userTokenVersion === "2.0"
        ? "Azure AD B2C v2"
        : user.userTokenVersion;

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
      message: "Microsoft authentication successful",
      user: userResponse,
      accessToken: tokenData.token, // This now includes roles and permissions
    });
  } catch (error) {
    console.error("Microsoft Auth Error:", error);
    return res.status(500).json({
      success: false,
      message: "Authentication failed",
      error: error.message,
    });
  }
};
