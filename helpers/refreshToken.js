const jwt = require("jsonwebtoken");
const User = require("../models/user");
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

      // Check if refresh token is expired (if expiry is stored)
      if (user.tokens.refresh_token_expires_in) {
        const tokenAge =
          Date.now() - user.tokens.refresh_token_expires_in * 1000;
        const maxAge = 90 * 24 * 60 * 60 * 1000; // 90 days in milliseconds

        if (tokenAge > maxAge) {
          console.log("❌ Refresh token expired");
          // Clear expired refresh token
          await User.findByIdAndUpdate(user._id, {
            "tokens.refresh_token": null,
            "tokens.refresh_token_expires_in": null,
          });
          throw new Error("Refresh token expired");
        }
      }

      // Generate new access token
      console.log("🔄 Generating new access token...");
      const tokenData = await generateToken(user);

      // Optionally rotate refresh token (security best practice)
      const shouldRotateRefreshToken =
        process.env.ROTATE_REFRESH_TOKEN === "true";

      if (shouldRotateRefreshToken) {
        console.log("🔄 Rotating refresh token...");
        // Generate new refresh token (you might want to get this from Microsoft again)
        // For now, we'll keep the same refresh token but update expiry
        await User.findByIdAndUpdate(user._id, {
          "tokens.refresh_token_expires_in":
            Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90 days
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

      const cutoffTime = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60; // 90 days ago

      const result = await User.updateMany(
        {
          "tokens.refresh_token_expires_in": { $lt: cutoffTime },
        },
        {
          $unset: {
            "tokens.refresh_token": 1,
            "tokens.refresh_token_expires_in": 1,
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
