const RefreshTokenHelper = require("../helpers/refreshToken");
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
  static async refreshToken(req, res) {
    try {
      console.log("=== Token Refresh Request ===");

      const { refreshToken } = req.body;

      if (!refreshToken) {
        const error = AppError.badRequest("Refresh token is required", {
          tokenError: true,
          missingRefreshToken: true,
        });
        return res.status(error.status).json({
          success: false,
          error: {
            message: error.message,
            code: error.code,
            status: error.status,
            tokenError: error.tokenError,
            missingRefreshToken: error.missingRefreshToken,
          },
        });
      }

      // Validate refresh token and generate new access token
      const result = await RefreshTokenHelper.validateAndRefresh(refreshToken);

      console.log("✅ Token refresh successful for user:", result.user.email);

      return res.status(200).json({
        success: true,
        message: "Token refreshed successfully",
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
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
        const authError = AppError.unauthorized(
          "Invalid or expired refresh token",
          {
            tokenError: true,
            invalidRefreshToken: true,
          }
        );
        return res.status(authError.status).json({
          success: false,
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            invalidRefreshToken: authError.invalidRefreshToken,
          },
        });
      }

      // Generic server error
      const serverError = AppError.internalServerError(
        "Failed to refresh token"
      );
      return res.status(serverError.status).json({
        success: false,
        error: {
          message: serverError.message,
          code: serverError.code,
          status: serverError.status,
        },
      });
    }
  }

  /**
   * Revoke refresh token (logout)
   * POST /auth/revoke
   */
  static async revokeToken(req, res) {
    try {
      console.log("=== Token Revocation Request ===");

      const { refreshToken } = req.body;
      const userId = req.ctx?.userId; // From auth middleware if available

      if (!refreshToken) {
        const error = AppError.badRequest("Refresh token is required");
        return res.status(error.status).json({
          success: false,
          error: {
            message: error.message,
            code: error.code,
            status: error.status,
          },
        });
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

      const serverError = AppError.internalServerError(
        "Failed to revoke token"
      );
      return res.status(serverError.status).json({
        success: false,
        error: {
          message: serverError.message,
          code: serverError.code,
          status: serverError.status,
        },
      });
    }
  }

  /**
   * Revoke all refresh tokens for current user (security logout)
   * POST /auth/revoke-all
   */
  static async revokeAllTokens(req, res) {
    try {
      console.log("=== Revoke All Tokens Request ===");

      const userId = req.ctx?.userId;

      if (!userId) {
        const error = AppError.unauthorized("User authentication required");
        return res.status(error.status).json({
          success: false,
          error: {
            message: error.message,
            code: error.code,
            status: error.status,
          },
        });
      }

      // Revoke all refresh tokens for the user
      const revoked = await RefreshTokenHelper.revokeAllRefreshTokens(userId);

      if (!revoked) {
        console.log("⚠️ User not found for token revocation");
        return res.status(404).json({
          success: false,
          error: {
            message: "User not found",
            code: "USER_NOT_FOUND",
            status: 404,
          },
        });
      }

      console.log("✅ All refresh tokens revoked for user:", userId);

      return res.status(200).json({
        success: true,
        message: "All tokens revoked successfully",
      });
    } catch (error) {
      console.log("❌ Revoke all tokens failed:", error.message);

      const serverError = AppError.internalServerError(
        "Failed to revoke all tokens"
      );
      return res.status(serverError.status).json({
        success: false,
        error: {
          message: serverError.message,
          code: serverError.code,
          status: serverError.status,
        },
      });
    }
  }
}

module.exports = AuthController;
