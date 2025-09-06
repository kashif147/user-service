const User = require("../models/user");
const Role = require("../models/role");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { assignDefaultRole } = require("../helpers/roleAssignment");

module.exports.findUserByEmail = async (email) => {
  return await User.findOne({ userEmail: email }).exec();
};

module.exports.handleNewUser = async (email, password) => {
  try {
    const hashedPwd = await bcrypt.hash(password, 10);

    const result = await User.create({
      userEmail: email,
      password: hashedPwd,
      userType: "CRM",
    });

    // Assign default role to CRM users
    await assignDefaultRole(result, "CRM");

    const token = jwt.sign(
      {
        user: {
          id: result._id,
          email: result.userEmail,
          userType: "CRM",
        },
      },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "1d" }
    );

    return {
      user: {
        id: result._id,
        email: result.userEmail,
        userType: "CRM",
      },
      token: `Bearer ${token}`,
    };
  } catch (error) {
    throw new Error(`Error creating user: ${error.message}`);
  }
};

module.exports.handleLogin = async (email, password) => {
  const foundUser = await User.findOne({ userEmail: email }).exec();

  const match = await bcrypt.compare(password, foundUser.password);
  if (!match) {
    throw new Error("Invalid credentials");
  }

  const accessToken = jwt.sign(
    {
      user: {
        id: foundUser._id,
        email: foundUser.userEmail,
        userType: "CRM",
      },
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: "1d" }
  );

  foundUser.userLastLogin = new Date();
  await foundUser.save();

  return {
    user: {
      id: foundUser._id,
      email: foundUser.userEmail,
      userType: "CRM",
    },
    token: `Bearer ${accessToken}`,
  };
};
