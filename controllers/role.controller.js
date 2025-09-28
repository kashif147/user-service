const RoleHandler = require("../handlers/role.handler");
const User = require("../models/user.model");
const { AppError } = require("../errors/AppError");

// Initialize roles
module.exports.initializeRoles = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;
    const roles = await RoleHandler.initializeRoles(tenantId);
    res.status(200).json({ status: "success", data: roles });
  } catch (error) {
    return next(AppError.internalServerError("Failed to initialize roles"));
  }
};

// Role CRUD operations
module.exports.createRole = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;
    const createdBy = req.ctx.userId;
    const role = await RoleHandler.createRole(req.body, tenantId, createdBy);
    res.status(201).json({ status: "success", data: role });
  } catch (error) {
    return next(AppError.internalServerError("Failed to create role"));
  }
};

module.exports.getAllRoles = async (req, res, next) => {
  try {
    const { category } = req.query;
    const tenantId = req.ctx.tenantId;
    const roles = await RoleHandler.getAllRoles(tenantId, category);
    res.status(200).json({ status: "success", data: roles });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve roles"));
  }
};

module.exports.getRoleById = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;
    const role = await RoleHandler.getRoleById(req.params.id, tenantId);
    if (!role) {
      return next(AppError.notFound("Role not found"));
    }
    res.status(200).json({ status: "success", data: role });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve role"));
  }
};

module.exports.updateRole = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;
    const updatedBy = req.ctx.userId;
    const role = await RoleHandler.updateRole(
      req.params.id,
      req.body,
      tenantId,
      updatedBy
    );
    if (!role) {
      return next(AppError.notFound("Role not found"));
    }
    res.status(200).json({ status: "success", data: role });
  } catch (error) {
    return next(AppError.internalServerError("Failed to update role"));
  }
};

module.exports.deleteRole = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;
    const result = await RoleHandler.deleteRole(req.params.id, tenantId);
    if (!result) {
      return next(AppError.notFound("Role not found"));
    }
    res.status(200).json({ status: "success", data: result.message });
  } catch (error) {
    return next(AppError.internalServerError("Failed to delete role"));
  }
};

module.exports.updateRolePermissions = async (req, res, next) => {
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
    if (!role) {
      return next(AppError.notFound("Role not found"));
    }
    res.status(200).json({ status: "success", data: role });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to update role permissions")
    );
  }
};

// User role management
// Batch role management (Super User only)
module.exports.assignRolesToUser = async (req, res, next) => {
  try {
    const { userId, roleIds } = req.body;
    const tenantId = req.ctx.tenantId;

    if (!Array.isArray(roleIds) || roleIds.length === 0) {
      return next(AppError.badRequest("roleIds must be a non-empty array"));
    }

    const result = await RoleHandler.assignRolesToUser(
      userId,
      roleIds,
      tenantId
    );

    res.status(200).json({
      status: "success",
      message: "Roles assigned to user successfully",
      data: {
        user: result.user,
        summary: {
          assignedRoles: result.assignedRoles,
          alreadyAssignedRoles: result.alreadyAssignedRoles,
          assignedRoleIds: result.assignedRoleIds,
          alreadyAssignedRoleIds: result.alreadyAssignedRoleIds,
        },
      },
    });
  } catch (error) {
    return next(AppError.internalServerError("Failed to assign roles to user"));
  }
};

module.exports.removeRolesFromUser = async (req, res, next) => {
  try {
    const { userId, roleIds } = req.body;
    const tenantId = req.ctx.tenantId;

    if (!Array.isArray(roleIds) || roleIds.length === 0) {
      return next(AppError.badRequest("roleIds must be a non-empty array"));
    }

    const result = await RoleHandler.removeRolesFromUser(
      userId,
      roleIds,
      tenantId
    );

    res.status(200).json({
      status: "success",
      message: "Roles removed from user successfully",
      data: {
        user: result.user,
        summary: {
          removedRoles: result.removedRoles,
          notAssignedRoles: result.notAssignedRoles,
          removedRoleIds: result.removedRoleIds,
          notAssignedRoleIds: result.notAssignedRoleIds,
        },
      },
    });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to remove roles from user")
    );
  }
};

module.exports.removeRoleFromUser = async (req, res, next) => {
  try {
    const { userId, roleId } = req.body;
    const tenantId = req.ctx.tenantId;
    const user = await RoleHandler.removeRoleFromUser(userId, roleId, tenantId);
    if (!user) {
      return next(AppError.notFound("User or role not found"));
    }
    res.status(200).json({ status: "success", data: user });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to remove role from user")
    );
  }
};

module.exports.getUserRoles = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;
    const roles = await RoleHandler.getUserRoles(req.params.userId, tenantId);
    res.status(200).json({ status: "success", data: roles });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve user roles"));
  }
};

module.exports.getUserPermissions = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;
    const permissions = await RoleHandler.getUserPermissions(
      req.params.userId,
      tenantId
    );
    res.status(200).json({ status: "success", data: permissions });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to retrieve user permissions")
    );
  }
};

module.exports.getUsersByRole = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;
    const users = await RoleHandler.getUsersByRole(req.params.roleId, tenantId);
    res.status(200).json({ status: "success", data: users });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to retrieve users by role")
    );
  }
};

module.exports.getAllUsers = async (req, res, next) => {
  try {
    const tenantId = req.ctx.tenantId;

    // Debug logging
    console.log("getAllUsers - tenantId:", tenantId);
    console.log("getAllUsers - req.ctx:", req.ctx);

    if (!tenantId) {
      console.error("getAllUsers - tenantId is missing from request context");
      return next(AppError.badRequest("Tenant ID is required"));
    }

    const Tenant = require("../models/tenant.model");

    // Get tenant information
    console.log("getAllUsers - fetching tenant with ID:", tenantId);
    const tenant = await Tenant.findOne({
      "authenticationConnections.directoryId": tenantId,
    }).select("name");
    console.log("getAllUsers - tenant found:", tenant);

    console.log("getAllUsers - fetching users for tenantId:", tenantId);
    const users = await User.find({ tenantId })
      .populate("roles")
      .select("-password -tokens");
    console.log("getAllUsers - users found:", users.length);

    // Add tenant name to each user
    const usersWithTenantName = users.map((user) => ({
      ...user.toObject(),
      tenantName: tenant?.name || null,
    }));

    res.status(200).json({ status: "success", data: usersWithTenantName });
  } catch (error) {
    console.error("getAllUsers - error details:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
      tenantId: req.ctx?.tenantId,
    });
    return next(
      AppError.internalServerError(`Failed to retrieve users: ${error.message}`)
    );
  }
};

module.exports.testDefaultRoleAssignment = async (req, res, next) => {
  try {
    const User = require("../models/user.model");
    const { assignDefaultRole } = require("../helpers/roleAssignment");

    const { userType, email, fullName } = req.body;
    const tenantId = req.ctx.tenantId;

    if (!userType || !email || !fullName) {
      return next(
        AppError.badRequest("userType, email, and fullName are required")
      );
    }

    if (!["PORTAL", "CRM"].includes(userType)) {
      return next(AppError.badRequest("userType must be PORTAL or CRM"));
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

    res.status(201).json({
      status: "success",
      message: "Test user created with default role",
      data: {
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
      },
    });
  } catch (error) {
    return next(AppError.internalServerError("Failed to create test user"));
  }
};

module.exports.hasRole = async (req, res, next) => {
  try {
    const { userId, roleCode } = req.params;
    const tenantId = req.ctx.tenantId;
    const hasRole = await RoleHandler.hasRole(userId, roleCode, tenantId);
    res.status(200).json({ status: "success", data: { hasRole } });
  } catch (error) {
    return next(AppError.internalServerError("Failed to check user role"));
  }
};
