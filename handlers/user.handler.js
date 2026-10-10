const User = require("../models/user.model");
const Role = require("../models/role.model");

module.exports.findUserByEmail = async (email, tenantId) => {
  return await User.findOne({ userEmail: email, tenantId }).exec();
};

module.exports.handleLogout = async (userId, tenantId) => {
  try {
    console.log("=== User Logout Handler: Starting ===");
    console.log("User ID:", userId);
    console.log("Tenant ID:", tenantId);

    // Find user
    const user = await User.findOne({ _id: userId, tenantId }).exec();
    if (!user) {
      throw new Error("User not found");
    }

    // Clear all tokens
    await User.findByIdAndUpdate(userId, {
      $unset: {
        "tokens.refresh_token": 1,
        "tokens.refresh_token_expires_in": 1,
        "tokens.refresh_token_expires_at": 1,
        "tokens.id_token": 1,
        "tokens.access_token": 1,
      },
    });

    // Update last logout time
    user.userLastLogout = new Date();
    await user.save();

    console.log("✅ User logout handler completed successfully");
    return {
      success: true,
      userId: userId,
      logoutTime: user.userLastLogout,
    };
  } catch (error) {
    console.log("❌ User logout handler failed:", error.message);
    throw error;
  }
};
