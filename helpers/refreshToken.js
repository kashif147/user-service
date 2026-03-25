const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { generateToken } = require("./jwt");

/**
 * Refresh Token Helper
 * Handles refresh token validation and access token renewal
 */
class RefreshTokenHelper {
  /**
   * Validate refresh token and generate new access token
   * @param {string} refreshToken - The refresh token to validate
   * @returns {Object} - New tokens and user data
   */
  static async validateAndRefresh(refreshToken) {
    try {
      console.log("=== Refresh Token Validation: Starting ===");

      if (!refreshToken) {
        throw new Error("Refresh token is required");
      }

      // Find user by refresh token
      const user = await User.findOne({
        "tokens.refresh_token": refreshToken,
        isActive: true,
      });

      if (!user) {
        console.log("❌ User not found with provided refresh token");
        throw new Error("Invalid refresh token");
      }

      console.log("✅ User found:", user.userEmail);

      // Microsoft sends refresh_token_expires_in as *remaining seconds*, not Unix time.
      // We persist absolute deadline as refresh_token_expires_at (ms).
      const expiresAt = user.tokens.refresh_token_expires_at;
      if (expiresAt != null && Date.now() > expiresAt) {
        console.log("❌ Refresh token expired");
        await User.findByIdAndUpdate(user._id, {
          $unset: {
            "tokens.refresh_token": 1,
            "tokens.refresh_token_expires_in": 1,
            "tokens.refresh_token_expires_at": 1,
          },
        });
        throw new Error("Refresh token expired");
      }

      // Generate new access token
      console.log("🔄 Generating new access token...");
      const tokenData = await generateToken(user);

      // Optionally rotate refresh token (security best practice)
      const shouldRotateRefreshToken =
        process.env.ROTATE_REFRESH_TOKEN === "true";

      if (shouldRotateRefreshToken) {
        console.log("🔄 Rotating refresh token...");
        const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
        await User.findByIdAndUpdate(user._id, {
          "tokens.refresh_token_expires_at": Date.now() + ninetyDaysMs,
          "tokens.refresh_token_expires_in": Math.floor(ninetyDaysMs / 1000),
        });
      }

      console.log("✅ Token refresh successful");

      return {
        success: true,
        accessToken: tokenData.token,
        refreshToken: refreshToken, // Keep same or rotate based on config
        user: {
          id: user._id,
          email: user.userEmail,
          firstName: user.userFirstName,
          lastName: user.userLastName,
          fullName: user.userFullName,
          tenantId: user.tenantId,
          userType: user.userType,
        },
        expiresIn: process.env.JWT_EXPIRY || "1h",
      };
    } catch (error) {
      console.log("❌ Refresh token validation failed:", error.message);
      throw error;
    }
  }

  /**
   * Revoke refresh token (for logout)
   * @param {string} refreshToken - The refresh token to revoke
   * @param {string} userId - User ID (optional, for additional security)
   */
  static async revokeRefreshToken(refreshToken, userId = null) {
    try {
      console.log("=== Revoking Refresh Token ===");

      const query = { "tokens.refresh_token": refreshToken };
      if (userId) {
        query._id = userId;
      }

      const result = await User.updateOne(query, {
        $unset: {
          "tokens.refresh_token": 1,
          "tokens.refresh_token_expires_in": 1,
          "tokens.refresh_token_expires_at": 1,
        },
      });

      if (result.modifiedCount === 0) {
        console.log("⚠️ No refresh token found to revoke");
        return false;
      }

      console.log("✅ Refresh token revoked successfully");
      return true;
    } catch (error) {
      console.log("❌ Failed to revoke refresh token:", error.message);
      throw error;
    }
  }

  /**
   * Revoke all refresh tokens for a user (for security)
   * @param {string} userId - User ID
   */
  static async revokeAllRefreshTokens(userId) {
    try {
      console.log("=== Revoking All Refresh Tokens for User ===");

      const result = await User.findByIdAndUpdate(userId, {
        $unset: {
          "tokens.refresh_token": 1,
          "tokens.refresh_token_expires_in": 1,
          "tokens.refresh_token_expires_at": 1,
        },
      });

      if (!result) {
        console.log("⚠️ User not found");
        return false;
      }

      console.log("✅ All refresh tokens revoked for user");
      return true;
    } catch (error) {
      console.log("❌ Failed to revoke all refresh tokens:", error.message);
      throw error;
    }
  }

  /**
   * Clean up expired refresh tokens (maintenance task)
   */
  static async cleanupExpiredRefreshTokens() {
    try {
      console.log("=== Cleaning Up Expired Refresh Tokens ===");

      const now = Date.now();

      const result = await User.updateMany(
        {
          "tokens.refresh_token_expires_at": { $lt: now, $exists: true, $ne: null },
        },
        {
          $unset: {
            "tokens.refresh_token": 1,
            "tokens.refresh_token_expires_in": 1,
            "tokens.refresh_token_expires_at": 1,
          },
        }
      );

      console.log(
        `✅ Cleaned up ${result.modifiedCount} expired refresh tokens`
      );
      return result.modifiedCount;
    } catch (error) {
      console.log(
        "❌ Failed to cleanup expired refresh tokens:",
        error.message
      );
      throw error;
    }
  }
}

module.exports = RefreshTokenHelper;
