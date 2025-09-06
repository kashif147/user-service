const RoleHandler = require("../handlers/role.handler");
const User = require("../models/user");

// Initialize roles
module.exports.initializeRoles = async (req, res) => {
  try {
    const roles = await RoleHandler.initializeRoles();
    res.success("Roles initialized successfully", roles);
  } catch (error) {
    res.fail(error.message);
  }
};

// Role CRUD operations
module.exports.createRole = async (req, res) => {
  try {
    const role = await RoleHandler.createRole(req.body);
    res.success("Role created successfully", role);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getAllRoles = async (req, res) => {
  try {
    const { userType } = req.query;
    const roles = await RoleHandler.getAllRoles(userType);
    res.success("Roles fetched successfully", roles);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getRoleById = async (req, res) => {
  try {
    const role = await RoleHandler.getRoleById(req.params.id);
    res.success("Role fetched successfully", role);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.updateRole = async (req, res) => {
  try {
    const role = await RoleHandler.updateRole(req.params.id, req.body);
    res.success("Role updated successfully", role);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.deleteRole = async (req, res) => {
  try {
    const result = await RoleHandler.deleteRole(req.params.id);
    res.success(result.message);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.updateRolePermissions = async (req, res) => {
  try {
    const { permissions } = req.body;
    const role = await RoleHandler.updateRolePermissions(
      req.params.id,
      permissions
    );
    res.success("Role permissions updated successfully", role);
  } catch (error) {
    res.fail(error.message);
  }
};

// User role management
module.exports.assignRoleToUser = async (req, res) => {
  try {
    const { userId, roleId } = req.body;
    const user = await RoleHandler.assignRoleToUser(userId, roleId);
    res.success("Role assigned to user successfully", user);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.removeRoleFromUser = async (req, res) => {
  try {
    const { userId, roleId } = req.body;
    const user = await RoleHandler.removeRoleFromUser(userId, roleId);
    res.success("Role removed from user successfully", user);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getUserRoles = async (req, res) => {
  try {
    const roles = await RoleHandler.getUserRoles(req.params.userId);
    res.success("User roles fetched successfully", roles);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getUserPermissions = async (req, res) => {
  try {
    const permissions = await RoleHandler.getUserPermissions(req.params.userId);
    res.success("User permissions fetched successfully", permissions);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getUsersByRole = async (req, res) => {
  try {
    const users = await RoleHandler.getUsersByRole(req.params.roleId);
    res.success("Users fetched successfully", users);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find({})
      .populate("roles")
      .select("-password -tokens");
    res.success("Users fetched successfully", users);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.testDefaultRoleAssignment = async (req, res) => {
  try {
    const User = require("../models/user");
    const { assignDefaultRole } = require("../helpers/roleAssignment");

    const { userType, email, fullName } = req.body;

    if (!userType || !email || !fullName) {
      return res.fail("userType, email, and fullName are required");
    }

    if (!["PORTAL", "CRM"].includes(userType)) {
      return res.fail("userType must be PORTAL or CRM");
    }

    // Create test user
    const testUser = new User({
      userEmail: email,
      userFullName: fullName,
      userType: userType,
    });

    // Assign default role
    await assignDefaultRole(testUser, userType);
    await testUser.save();

    // Fetch user with populated roles
    const userWithRoles = await User.findById(testUser._id).populate("roles");

    res.success("Test user created with default role", {
      user: {
        id: userWithRoles._id,
        email: userWithRoles.userEmail,
        fullName: userWithRoles.userFullName,
        userType: userWithRoles.userType,
        roles: userWithRoles.roles.map((role) => ({
          id: role._id,
          code: role.code,
          name: role.name,
        })),
      },
    });
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.hasRole = async (req, res) => {
  try {
    const { userId, roleCode } = req.params;
    const hasRole = await RoleHandler.hasRole(userId, roleCode);
    res.success("Role check completed", { hasRole });
  } catch (error) {
    res.fail(error.message);
  }
};
