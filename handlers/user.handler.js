const User = require("../models/user.model");
const Role = require("../models/role.model");
const bcrypt = require("bcryptjs");
const jwtHelper = require("../helpers/jwt");
const { assignDefaultRole } = require("../helpers/roleAssignment");

module.exports.findUserByEmail = async (email, tenantId) => {
  return await User.findOne({ userEmail: email, tenantId }).exec();
};

module.exports.handleNewUser = async (email, password, tenantId, createdBy) => {
  try {
    const hashedPwd = await bcrypt.hash(password, 10);

    const result = await User.create({
      userEmail: email,
      password: hashedPwd,
      userType: "CRM",
      tenantId: tenantId,
      createdBy: createdBy,
    });

    // Assign default role to CRM users
    await assignDefaultRole(result, "CRM", tenantId);

    // Use the new JWT helper that includes roles and permissions
    const tokenData = await jwtHelper.generateToken(result);

    return {
      user: {
        id: result._id,
        email: result.userEmail,
        userType: result.userType,
        tenantId: result.tenantId,
      },
      token: tokenData.token, // This now includes roles and permissions
    };
  } catch (error) {
    throw new Error(`Error creating user: ${error.message}`);
  }
};

module.exports.handleLogin = async (email, password, tenantId) => {
  const foundUser = await User.findOne({ userEmail: email, tenantId }).exec();

  if (!foundUser) {
    throw new Error("Invalid credentials");
  }

  const match = await bcrypt.compare(password, foundUser.password);
  if (!match) {
    throw new Error("Invalid credentials");
  }

  // Use the new JWT helper that includes roles and permissions
  const tokenData = await jwtHelper.generateToken(foundUser);

  foundUser.userLastLogin = new Date();
  await foundUser.save();

  return {
    user: {
      id: foundUser._id,
      email: foundUser.userEmail,
      userType: foundUser.userType,
      tenantId: foundUser.tenantId,
    },
    token: tokenData.token, // This now includes roles and permissions
  };
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
