const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  userEmail: { type: String, default: null }, // `emails[0]` ADB2C
  userFirstName: { type: String, default: null }, // `given_name` ADB2C
  userLastName: { type: String, default: null }, // `family_name` ADB2C
  userFullName: { type: String, default: null }, //given_name + family_name ADB2C
  userMobilePhone: { type: String, default: null }, // `extension_mobilePhone` ADB2C
  userMemberNumber: { type: String, default: null }, // `extension_MemberNo` ADB2C
  userMicrosoftId: { type: String, default: null }, // `oid` ADB2C
  userAuthProvider: { type: String, default: "microsoft" }, // fixed value for tracking auth source ADB2C
  userSubject: { type: String, default: null }, // `sub` ADB2C
  userAudience: { type: String, default: null }, // `aud` ADB2C
  userIssuer: { type: String, default: null }, // `iss` ADB2C
  userIssuedAt: { type: Number, default: null }, // `iat` ADB2C
  userAuthTime: { type: Number, default: null }, // `auth_time` ADB2C
  userTokenVersion: { type: String, default: null }, // `ver` ADB2C
  userPolicy: { type: String, default: null }, // `tfp` ADB2C
  userType: { type: String, enum: ["PORTAL", "CRM"], default: "PORTAL" }, // PORTAL for B2C, CRM for Azure AD
  userLastLogin: { type: Date, default: Date.now }, // current timestamp

  tokens: {
    id_token: { type: String, default: null }, // full ID token from Microsoft
    refresh_token: { type: String, default: null }, // refresh token
    id_token_expires_in: { type: Number, default: null }, // token expiry time (optional)
    refresh_token_expires_in: { type: Number, default: null }, // refresh token expiry (optional)
  },
});

module.exports = mongoose.model("User", UserSchema);
