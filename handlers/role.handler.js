const Role = require("../models/role");
const User = require("../models/user");

// Role definitions
const ROLE_DEFINITIONS = [
  // System Role
  {
    name: "Super User",
    code: "SU",
    description:
      "Super User with full system access and role management capabilities",
    userType: "SYSTEM",
    permissions: ["*"], // Full access
    isSystemRole: true,
  },
  // Portal Roles
  {
    name: "Member",
    code: "MEMBER",
    description: "Registered member with full portal access",
    userType: "PORTAL",
    permissions: [],
  },
  {
    name: "Non-Member",
    code: "NON-MEMBER",
    description: "Non-member with limited portal access",
    userType: "PORTAL",
    permissions: [],
  },
  // CRM Roles
  {
    name: "Read Only",
    code: "REO",
    description: "Read Only access with limited permissions",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Membership Officer",
    code: "MO",
    description: "Membership Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Assistant Membership Officer",
    code: "AMO",
    description: "Assistant Membership Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Accounts Manager",
    code: "AM",
    description: "Accounts Manager",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Deputy Accounts Manager",
    code: "DAM",
    description: "Deputy Accounts Manager",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Accounts Assistant",
    code: "AA",
    description: "Accounts Assistant",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Director of Industrial Relations",
    code: "DIR",
    description: "Director of Industrial Relations",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Industrial Relation Executive",
    code: "IRE",
    description: "Industrial Relation Executive",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Assistant Director Industrial Relations",
    code: "ADIR",
    description: "Assistant Director Industrial Relations",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Industrial Relations Officers",
    code: "IRO",
    description: "Industrial Relations Officers",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Information Officer",
    code: "IO",
    description: "Information Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Director of Professional and Regulatory Services",
    code: "DPRS",
    description: "Director of Professional and Regulatory Services",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Regional Officer",
    code: "RO",
    description: "Regional Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Branch Officer",
    code: "BO",
    description: "Branch Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "General Secretary",
    code: "GS",
    description: "General Secretary",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Deputy General Secretary",
    code: "DGS",
    description: "Deputy General Secretary",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Head of Library Services",
    code: "HLS",
    description: "Head of Library Services",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Librarian",
    code: "LS",
    description: "Librarian",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Library Assistant",
    code: "LA",
    description: "Library Assistant",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Course Coordinator",
    code: "CC",
    description: "Course Coordinator",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Assistant Course Coordinator",
    code: "ACC",
    description: "Assistant Course Coordinator",
    userType: "CRM",
    permissions: [],
  },
];

module.exports.initializeRoles = async (tenantId) => {
  try {
    // Check if roles already exist for this tenant
    const existingRoles = await Role.countDocuments({ tenantId });
    if (existingRoles > 0) {
      console.log(`Roles already initialized for tenant ${tenantId}`);
      return await Role.find({ tenantId });
    }

    // Create all roles with tenantId
    const rolesWithTenant = ROLE_DEFINITIONS.map((role) => ({
      ...role,
      tenantId: tenantId,
      createdBy: "system",
    }));

    const createdRoles = await Role.insertMany(rolesWithTenant);
    console.log(
      `Initialized ${createdRoles.length} roles for tenant ${tenantId}`
    );
    return createdRoles;
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

module.exports.assignRoleToUser = async (userId, roleId, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId });
    const role = await Role.findOne({ _id: roleId, tenantId });

    if (!user) {
      throw new Error("User not found");
    }
    if (!role) {
      throw new Error("Role not found");
    }

    // Check if user already has this role
    if (user.roles.includes(roleId)) {
      throw new Error("User already has this role");
    }

    user.roles.push(roleId);
    await user.save();

    return await User.findOne({ _id: userId, tenantId }).populate("roles");
  } catch (error) {
    throw new Error(`Error assigning role to user: ${error.message}`);
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
    user.roles.forEach((role) => {
      role.permissions.forEach((permission) => {
        permissions.add(permission);
      });
    });

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
