const AzureADHandler = require("../handlers/azure.ad.handler");
const jwt = require("jsonwebtoken");

module.exports.handleAzureADCallback = async (req, res) => {
  try {
    const { code, codeVerifier } = req.body;

    if (!code || !codeVerifier) {
      return res.status(400).json({ success: false, message: "Authorization code and codeVerifier are required" });
    }

    const { user } = await AzureADHandler.handleAzureADAuth(code, codeVerifier);

    const issuedAtReadable = user.userIssuedAt ? new Date(user.userIssuedAt * 1000).toISOString() : null;
    const authTimeReadable = user.userAuthTime ? new Date(user.userAuthTime * 1000).toISOString() : null;
    const tokenVersionReadable = user.userTokenVersion || "Azure AD v2";

    const accessToken =
      "Bearer " +
      jwt.sign(
        {
          user: {
            id: user._id,
            userEmail: user.userEmail,
            userFullName: user.userFullName,
            userMicrosoftId: user.userMicrosoftId,
            userMemberNumber: user.userMemberNumber,
            userMobilePhone: user.userMobilePhone,
            userPolicy: user.userPolicy,
            userIssuedAt: issuedAtReadable,
            userAuthTime: authTimeReadable,
            tokenVersion: tokenVersionReadable,
            userType: "CRM",
          },
        },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "1y" }
      );

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
      accessToken,
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
