const RoleHandler = require("../handlers/role.handler");
const User = require("../models/user");

// Initialize roles
module.exports.initializeRoles = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const roles = await RoleHandler.initializeRoles(tenantId);
    res.success("Roles initialized successfully", roles);
  } catch (error) {
    res.fail(error.message);
  }
};

// Role CRUD operations
module.exports.createRole = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const createdBy = req.ctx.userId;
    const role = await RoleHandler.createRole(req.body, tenantId, createdBy);
    res.success("Role created successfully", role);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getAllRoles = async (req, res) => {
  try {
    const { userType } = req.query;
    const tenantId = req.ctx.tenantId;
    const roles = await RoleHandler.getAllRoles(tenantId, userType);
    res.success("Roles fetched successfully", roles);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getRoleById = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const role = await RoleHandler.getRoleById(req.params.id, tenantId);
    res.success("Role fetched successfully", role);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.updateRole = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const updatedBy = req.ctx.userId;
    const role = await RoleHandler.updateRole(
      req.params.id,
      req.body,
      tenantId,
      updatedBy
    );
    res.success("Role updated successfully", role);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.deleteRole = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const result = await RoleHandler.deleteRole(req.params.id, tenantId);
    res.success(result.message);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.updateRolePermissions = async (req, res) => {
  try {
    const { permissions } = req.body;
    const tenantId = req.ctx.tenantId;
    const updatedBy = req.ctx.userId;
    const role = await RoleHandler.updateRolePermissions(
      req.params.id,
      permissions,
      tenantId,
      updatedBy
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
    const tenantId = req.ctx.tenantId;
    const user = await RoleHandler.assignRoleToUser(userId, roleId, tenantId);
    res.success("Role assigned to user successfully", user);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.removeRoleFromUser = async (req, res) => {
  try {
    const { userId, roleId } = req.body;
    const tenantId = req.ctx.tenantId;
    const user = await RoleHandler.removeRoleFromUser(userId, roleId, tenantId);
    res.success("Role removed from user successfully", user);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getUserRoles = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const roles = await RoleHandler.getUserRoles(req.params.userId, tenantId);
    res.success("User roles fetched successfully", roles);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getUserPermissions = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const permissions = await RoleHandler.getUserPermissions(
      req.params.userId,
      tenantId
    );
    res.success("User permissions fetched successfully", permissions);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getUsersByRole = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const users = await RoleHandler.getUsersByRole(req.params.roleId, tenantId);
    res.success("Users fetched successfully", users);
  } catch (error) {
    res.fail(error.message);
  }
};

module.exports.getAllUsers = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const users = await User.find({ tenantId })
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
    const tenantId = req.ctx.tenantId;

    if (!userType || !email || !fullName) {
      return res.fail("userType, email, and fullName are required");
    }

    if (!["PORTAL", "CRM"].includes(userType)) {
      return res.fail("userType must be PORTAL or CRM");
    }

    // Create test user with tenantId
    const testUser = new User({
      userEmail: email,
      userFullName: fullName,
      userType: userType,
      tenantId: tenantId,
      createdBy: req.ctx.userId,
    });

    // Assign default role with tenantId
    await assignDefaultRole(testUser, userType, tenantId);
    await testUser.save();

    // Fetch user with populated roles
    const userWithRoles = await User.findOne({
      _id: testUser._id,
      tenantId,
    }).populate("roles");

    res.success("Test user created with default role", {
      user: {
        id: userWithRoles._id,
        email: userWithRoles.userEmail,
        fullName: userWithRoles.userFullName,
        userType: userWithRoles.userType,
        tenantId: userWithRoles.tenantId,
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
    const tenantId = req.ctx.tenantId;
    const hasRole = await RoleHandler.hasRole(userId, roleCode, tenantId);
    res.success("Role check completed", { hasRole });
  } catch (error) {
    res.fail(error.message);
  }
};
