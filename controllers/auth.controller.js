const RefreshTokenHelper = require("../helpers/refreshToken");
const UserHandler = require("../handlers/user.handler");
const { encryptToken } = require("../helpers/tokenEncryption");
const { AppError } = require("../errors/AppError");

/**
 * Authentication Controller
 * Handles authentication-related operations including token refresh
 */
class AuthController {
  /**
   * Refresh access token using refresh token
   * POST /auth/refresh
   */
  static async refreshToken(req, res, next) {
    try {
      console.log("=== Token Refresh Request ===");

      const { refreshToken } = req.body;

      if (!refreshToken) {
        return next(AppError.badRequest("Refresh token is required"));
      }

      // Validate refresh token and generate new access token
      const result = await RefreshTokenHelper.validateAndRefresh(refreshToken);

      console.log("✅ Token refresh successful for user:", result.user.email);

      // Encrypt the tokens before sending to frontend
      const encryptedAccessToken = encryptToken(result.accessToken);
      const encryptedRefreshToken = result.refreshToken 
        ? encryptToken(result.refreshToken) 
        : undefined;

      return res.status(200).json({
        success: true,
        message: "Token refreshed successfully",
        data: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          user: result.user,
          expiresIn: result.expiresIn,
        },
      });
    } catch (error) {
      console.log("❌ Token refresh failed:", error.message);

      // Handle specific error types
      if (
        error.message.includes("Invalid refresh token") ||
        error.message.includes("Refresh token expired")
      ) {
        return next(AppError.unauthorized("Invalid or expired refresh token"));
      }

      // Generic server error
      return next(AppError.internalServerError("Failed to refresh token"));
    }
  }

  /**
   * Revoke refresh token (logout)
   * POST /auth/revoke
   */
  static async revokeToken(req, res, next) {
    try {
      console.log("=== Token Revocation Request ===");

      const { refreshToken } = req.body;
      const userId = req.ctx?.userId; // From auth middleware if available

      if (!refreshToken) {
        return next(AppError.badRequest("Refresh token is required"));
      }

      // Revoke the refresh token
      const revoked = await RefreshTokenHelper.revokeRefreshToken(
        refreshToken,
        userId
      );

      if (!revoked) {
        console.log("⚠️ No refresh token found to revoke");
        return res.status(200).json({
          success: true,
          message: "Token already revoked or not found",
        });
      }

      console.log("✅ Refresh token revoked successfully");

      return res.status(200).json({
        success: true,
        message: "Token revoked successfully",
      });
    } catch (error) {
      console.log("❌ Token revocation failed:", error.message);
      return next(AppError.internalServerError("Failed to revoke token"));
    }
  }

  /**
   * Revoke all refresh tokens for current user (security logout)
   * POST /auth/revoke-all
   */
  static async revokeAllTokens(req, res, next) {
    try {
      console.log("=== Revoke All Tokens Request ===");

      const userId = req.ctx?.userId;

      if (!userId) {
        return next(AppError.unauthorized("User authentication required"));
      }

      // Revoke all refresh tokens for the user
      const revoked = await RefreshTokenHelper.revokeAllRefreshTokens(userId);

      if (!revoked) {
        console.log("⚠️ User not found for token revocation");
        return res.notFoundRecord("User not found");
      }

      console.log("✅ All refresh tokens revoked for user:", userId);

      return res.status(200).json({
        success: true,
        message: "All tokens revoked successfully",
      });
    } catch (error) {
      console.log("❌ Revoke all tokens failed:", error.message);
      return next(AppError.internalServerError("Failed to revoke all tokens"));
    }
  }

  /**
   * Logout user and revoke all tokens
   * POST /auth/logout
   */
  static async logout(req, res, next) {
    try {
      console.log("=== User Logout Request ===");

      const userId = req.ctx?.userId;
      const tenantId = req.ctx?.tenantId;
      const userEmail = req.ctx?.email;

      if (!userId) {
        return next(AppError.unauthorized("User authentication required"));
      }

      // Use user handler for comprehensive logout
      const logoutResult = await UserHandler.handleLogout(userId, tenantId);

      // Log logout event for audit
      const { auditLogger } = require("../middlewares/audit.mw");
      await auditLogger.logLogout(req, true, {
        userId: userId,
        tenantId: tenantId,
        userEmail: userEmail,
        tokensRevoked: true,
      });

      console.log("✅ User logged out successfully:", userEmail);

      return res.status(200).json({
        success: true,
        message: "Logged out successfully",
        data: {
          userId: userId,
          logoutTime: logoutResult.logoutTime,
        },
      });
    } catch (error) {
      console.log("❌ Logout failed:", error.message);

      // Log failed logout attempt
      const { auditLogger } = require("../middlewares/audit.mw");
      await auditLogger.logLogout(req, false, {
        error: error.message,
        tokensRevoked: false,
      });

      return next(AppError.internalServerError("Failed to logout"));
    }
  }
}

module.exports = AuthController;
