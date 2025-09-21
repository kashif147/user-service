const Role = require("../models/role.model");
const User = require("../models/user.model");
const Tenant = require("../models/tenant.model");
const Permission = require("../models/permission.model");
const mongoose = require("mongoose");

module.exports.initializeRoles = async (tenantId) => {
  try {
    // Check if roles already exist for this tenant
    const existingRoles = await Role.find({ tenantId });
    if (existingRoles.length > 0) {
      console.log(
        `Roles already initialized for tenant ${tenantId} - Found ${existingRoles.length} roles`
      );
      return existingRoles;
    }

    // If no roles exist, they should have been created during migration
    console.log(
      `No roles found for tenant ${tenantId}. Please run the migration script first.`
    );
    return [];
  } catch (error) {
    throw new Error(`Error initializing roles: ${error.message}`);
  }
};

module.exports.getAllRoles = async (tenantId, userType = null) => {
  try {
    const query = { tenantId, isActive: true };
    if (userType) {
      query.userType = userType;
    }
    return await Role.find(query).sort({ userType: 1, name: 1 });
  } catch (error) {
    throw new Error(`Error fetching roles: ${error.message}`);
  }
};

module.exports.getRoleByCode = async (code, tenantId) => {
  try {
    const role = await Role.findOne({ code, tenantId, isActive: true });
    if (!role) {
      throw new Error("Role not found");
    }
    return role;
  } catch (error) {
    throw new Error(`Error fetching role: ${error.message}`);
  }
};

module.exports.getRoleById = async (roleId, tenantId) => {
  try {
    const role = await Role.findOne({ _id: roleId, tenantId });
    if (!role) {
      throw new Error("Role not found");
    }
    return role;
  } catch (error) {
    throw new Error(`Error fetching role: ${error.message}`);
  }
};

module.exports.createRole = async (roleData, tenantId, createdBy) => {
  try {
    const role = new Role({
      ...roleData,
      tenantId,
      createdBy,
    });
    await role.save();
    return role;
  } catch (error) {
    throw new Error(`Error creating role: ${error.message}`);
  }
};

module.exports.updateRole = async (roleId, updateData, tenantId, updatedBy) => {
  try {
    const role = await Role.findOneAndUpdate(
      { _id: roleId, tenantId },
      { ...updateData, updatedAt: Date.now(), updatedBy },
      { new: true }
    );

    if (!role) {
      throw new Error("Role not found");
    }
    return role;
  } catch (error) {
    throw new Error(`Error updating role: ${error.message}`);
  }
};

module.exports.deleteRole = async (roleId, tenantId) => {
  try {
    const role = await Role.findOne({ _id: roleId, tenantId });
    if (!role) {
      throw new Error("Role not found");
    }

    if (role.isSystemRole) {
      throw new Error("Cannot delete system role");
    }

    // Check if any users have this role in this tenant
    const usersWithRole = await User.find({ roles: roleId, tenantId });
    if (usersWithRole.length > 0) {
      throw new Error("Cannot delete role that is assigned to users");
    }

    await Role.findOneAndUpdate({ _id: roleId, tenantId }, { isActive: false });
    return { message: "Role deleted successfully" };
  } catch (error) {
    throw new Error(`Error deleting role: ${error.message}`);
  }
};

module.exports.updateRolePermissions = async (
  roleId,
  permissions,
  tenantId,
  updatedBy
) => {
  try {
    const role = await Role.findOneAndUpdate(
      { _id: roleId, tenantId },
      { permissions, updatedAt: Date.now(), updatedBy },
      { new: true }
    );

    if (!role) {
      throw new Error("Role not found");
    }
    return role;
  } catch (error) {
    throw new Error(`Error updating role permissions: ${error.message}`);
  }
};

module.exports.assignRolesToUser = async (userId, roleIds, tenantId) => {
  try {
    // Validate ObjectId formats
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new Error(
        `Invalid userId format: ${userId}. ObjectId must be a 24-character hex string.`
      );
    }

    for (const roleId of roleIds) {
      if (!mongoose.Types.ObjectId.isValid(roleId)) {
        throw new Error(
          `Invalid roleId format: ${roleId}. ObjectId must be a 24-character hex string.`
        );
      }
    }

    const user = await User.findOne({ _id: userId, tenantId });

    if (!user) {
      throw new Error("User not found");
    }

    // Validate all roles exist and belong to the tenant
    const roles = await Role.find({
      _id: { $in: roleIds },
      tenantId,
      isActive: true,
    });

    if (roles.length !== roleIds.length) {
      const foundRoleIds = roles.map((role) => role._id.toString());
      const missingRoleIds = roleIds.filter((id) => !foundRoleIds.includes(id));
      throw new Error(`Roles not found: ${missingRoleIds.join(", ")}`);
    }

    // Check which roles user already has
    const existingRoleIds = user.roles.map((roleId) => roleId.toString());
    const newRoleIds = roleIds.filter(
      (roleId) => !existingRoleIds.includes(roleId)
    );
    const alreadyAssignedRoleIds = roleIds.filter((roleId) =>
      existingRoleIds.includes(roleId)
    );

    if (newRoleIds.length === 0) {
      throw new Error("User already has all the specified roles");
    }

    // Add new roles to user (convert strings to ObjectIds)
    const objectIdRoleIds = [];
    for (const id of newRoleIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error(
          `Invalid ObjectId format: ${id}. ObjectId must be a 24-character hex string.`
        );
      }
      objectIdRoleIds.push(new mongoose.Types.ObjectId(id));
    }
    user.roles.push(...objectIdRoleIds);
    await user.save();

    // Get updated user with populated roles
    const updatedUser = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );

    return {
      user: updatedUser,
      assignedRoles: newRoleIds.length,
      alreadyAssignedRoles: alreadyAssignedRoleIds.length,
      assignedRoleIds: newRoleIds,
      alreadyAssignedRoleIds: alreadyAssignedRoleIds,
    };
  } catch (error) {
    throw new Error(`Error assigning roles to user: ${error.message}`);
  }
};

module.exports.removeRolesFromUser = async (userId, roleIds, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId });

    if (!user) {
      throw new Error("User not found");
    }

    // Check which roles user actually has
    const existingRoleIds = user.roles.map((roleId) => roleId.toString());
    const rolesToRemove = roleIds.filter((roleId) =>
      existingRoleIds.includes(roleId)
    );
    const notAssignedRoleIds = roleIds.filter(
      (roleId) => !existingRoleIds.includes(roleId)
    );

    if (rolesToRemove.length === 0) {
      throw new Error("User doesn't have any of the specified roles");
    }

    // Remove roles from user
    user.roles = user.roles.filter(
      (roleId) => !roleIds.includes(roleId.toString())
    );
    await user.save();

    // Get updated user with populated roles
    const updatedUser = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );

    return {
      user: updatedUser,
      removedRoles: rolesToRemove.length,
      notAssignedRoles: notAssignedRoleIds.length,
      removedRoleIds: rolesToRemove,
      notAssignedRoleIds: notAssignedRoleIds,
    };
  } catch (error) {
    throw new Error(`Error removing roles from user: ${error.message}`);
  }
};

module.exports.removeRoleFromUser = async (userId, roleId, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) {
      throw new Error("User not found");
    }

    user.roles = user.roles.filter((role) => role.toString() !== roleId);
    await user.save();

    return await User.findOne({ _id: userId, tenantId }).populate("roles");
  } catch (error) {
    throw new Error(`Error removing role from user: ${error.message}`);
  }
};

module.exports.getUserPermissions = async (userId, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );
    if (!user) {
      throw new Error("User not found");
    }

    const permissions = new Set();

    // Check if user has Super User role
    const hasSuperUserRole = user.roles.some((role) => role.code === "SU");
    if (hasSuperUserRole) {
      return ["*"]; // Full access
    }

    // Collect permissions from all roles
    for (const role of user.roles) {
      // Handle both ObjectId and string permissions
      const objectIdPermissions = role.permissions.filter(
        (p) => typeof p === "string" && p.match(/^[0-9a-fA-F]{24}$/)
      );
      const stringPermissions = role.permissions.filter(
        (p) => typeof p === "string" && !p.match(/^[0-9a-fA-F]{24}$/)
      );

      // Get permission codes from ObjectId permissions
      if (objectIdPermissions.length > 0) {
        const permissionDocs = await Permission.find({
          _id: { $in: objectIdPermissions },
        });
        permissionDocs.forEach((perm) => {
          permissions.add(perm.code);
        });
      }

      // Add string permissions directly (for backward compatibility)
      stringPermissions.forEach((perm) => {
        permissions.add(perm);
      });
    }

    return Array.from(permissions);
  } catch (error) {
    throw new Error(`Error fetching user permissions: ${error.message}`);
  }
};

module.exports.getUserRoles = async (userId, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );
    if (!user) {
      throw new Error("User not found");
    }
    return user.roles;
  } catch (error) {
    throw new Error(`Error fetching user roles: ${error.message}`);
  }
};

module.exports.getUsersByRole = async (roleId, tenantId) => {
  try {
    return await User.find({ roles: roleId, tenantId }).populate("roles");
  } catch (error) {
    throw new Error(`Error fetching users by role: ${error.message}`);
  }
};

module.exports.hasRole = async (userId, roleCode, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );
    if (!user) {
      return false;
    }

    return user.roles.some((role) => role.code === roleCode);
  } catch (error) {
    throw new Error(`Error checking user role: ${error.message}`);
  }
};

// Additional helper functions to replace constants usage
module.exports.getAllRolesList = async (tenantId = null) => {
  try {
    const filter = { isActive: true };
    if (tenantId) {
      filter.tenantId = tenantId;
    }

    const roles = await Role.find(filter)
      .populate("tenantId", "name code")
      .sort({ userType: 1, name: 1 });

    // Transform to match sample roles format
    return roles.map((role) => ({
      id: role.code,
      name: role.name,
      description: role.description,
      tenantId: role.tenantId?._id?.toString(),
      tenantName: role.tenantId?.name,
      category: role.userType,
      permissions: role.permissions,
      status: role.isActive ? "active" : "inactive",
      isSystemRole: role.isSystemRole,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    }));
  } catch (error) {
    throw new Error(`Error fetching all roles list: ${error.message}`);
  }
};

module.exports.getRolesByCategory = async (tenantId = null) => {
  try {
    const roles = await this.getAllRolesList(tenantId);

    // Group roles by category (userType)
    return roles.reduce((acc, role) => {
      const category = role.category || "OTHER";
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(role);
      return acc;
    }, {});
  } catch (error) {
    throw new Error(`Error fetching roles by category: ${error.message}`);
  }
};

module.exports.getTenantsList = async () => {
  try {
    const tenants = await Tenant.find({ isActive: true })
      .select("_id name code description status")
      .sort({ name: 1 });

    return tenants.map((tenant) => ({
      id: tenant._id.toString(),
      name: tenant.name,
      code: tenant.code,
      description: tenant.description,
      status: tenant.status,
    }));
  } catch (error) {
    throw new Error(`Error fetching tenants list: ${error.message}`);
  }
};
