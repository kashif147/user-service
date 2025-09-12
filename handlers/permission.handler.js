const Permission = require("../models/permission");
const Role = require("../models/role");

module.exports.createPermission = async (permissionData, createdBy) => {
  try {
    // Check if permission code already exists
    const existingPermission = await Permission.findOne({
      code: permissionData.code,
    });

    if (existingPermission) {
      throw new Error("Permission code already exists");
    }

    const permission = await Permission.create({
      ...permissionData,
      createdBy,
    });

    return permission;
  } catch (error) {
    throw new Error(`Error creating permission: ${error.message}`);
  }
};

module.exports.getAllPermissions = async (filters = {}) => {
  try {
    const query = { isActive: true };

    if (filters.category) {
      query.category = filters.category;
    }

    if (filters.resource) {
      query.resource = filters.resource;
    }

    if (filters.level) {
      query.level = filters.level;
    }

    return await Permission.find(query)
      .sort({ category: 1, level: 1, name: 1 })
      .select("-__v");
  } catch (error) {
    throw new Error(`Error fetching permissions: ${error.message}`);
  }
};

module.exports.getPermissionById = async (permissionId) => {
  try {
    const permission = await Permission.findById(permissionId);
    if (!permission) {
      throw new Error("Permission not found");
    }
    return permission;
  } catch (error) {
    throw new Error(`Error fetching permission: ${error.message}`);
  }
};

module.exports.getPermissionByCode = async (code) => {
  try {
    const permission = await Permission.findOne({ code, isActive: true });
    if (!permission) {
      throw new Error("Permission not found");
    }
    return permission;
  } catch (error) {
    throw new Error(`Error fetching permission: ${error.message}`);
  }
};

module.exports.getPermissionsByResource = async (resource) => {
  try {
    const permissions = await Permission.find({
      resource,
      isActive: true,
    }).sort({ level: 1, action: 1 });

    return permissions;
  } catch (error) {
    throw new Error(`Error fetching permissions by resource: ${error.message}`);
  }
};

module.exports.getPermissionsByCategory = async (category) => {
  try {
    const permissions = await Permission.find({
      category,
      isActive: true,
    }).sort({ level: 1, name: 1 });

    return permissions;
  } catch (error) {
    throw new Error(`Error fetching permissions by category: ${error.message}`);
  }
};

module.exports.updatePermission = async (
  permissionId,
  updateData,
  updatedBy
) => {
  try {
    const permission = await Permission.findByIdAndUpdate(
      permissionId,
      { ...updateData, updatedBy },
      { new: true, runValidators: true }
    );

    if (!permission) {
      throw new Error("Permission not found");
    }

    return permission;
  } catch (error) {
    throw new Error(`Error updating permission: ${error.message}`);
  }
};

module.exports.deletePermission = async (permissionId) => {
  try {
    // Check if permission is used by any roles
    const rolesUsingPermission = await Role.find({
      permissions: permissionId,
    });

    if (rolesUsingPermission.length > 0) {
      throw new Error(
        `Cannot delete permission. It is used by ${rolesUsingPermission.length} role(s)`
      );
    }

    // Soft delete - mark as inactive
    const permission = await Permission.findByIdAndUpdate(
      permissionId,
      { isActive: false },
      { new: true }
    );

    if (!permission) {
      throw new Error("Permission not found");
    }

    return { message: "Permission deleted successfully" };
  } catch (error) {
    throw new Error(`Error deleting permission: ${error.message}`);
  }
};

module.exports.getPermissionStats = async () => {
  try {
    const [totalPermissions, activePermissions, systemPermissions] =
      await Promise.all([
        Permission.countDocuments(),
        Permission.countDocuments({ isActive: true }),
        Permission.countDocuments({ isSystemPermission: true }),
      ]);

    // Get permissions by category
    const permissionsByCategory = await Permission.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return {
      totalPermissions,
      activePermissions,
      inactivePermissions: totalPermissions - activePermissions,
      systemPermissions,
      customPermissions: totalPermissions - systemPermissions,
      permissionsByCategory,
    };
  } catch (error) {
    throw new Error(`Error fetching permission stats: ${error.message}`);
  }
};

module.exports.initializeDefaultPermissions = async () => {
  try {
    // Check if permissions already exist
    const existingPermissions = await Permission.countDocuments();
    if (existingPermissions > 0) {
      console.log("Permissions already initialized");
      return await Permission.find({ isActive: true });
    }

    const defaultPermissions = [
      // User permissions
      {
        name: "Read Users",
        code: "USER_READ",
        description: "View user information",
        resource: "user",
        action: "read",
        category: "USER",
        level: 1,
      },
      {
        name: "Write Users",
        code: "USER_WRITE",
        description: "Create and update users",
        resource: "user",
        action: "write",
        category: "USER",
        level: 30,
      },
      {
        name: "Delete Users",
        code: "USER_DELETE",
        description: "Delete users",
        resource: "user",
        action: "delete",
        category: "USER",
        level: 60,
      },
      {
        name: "Manage User Roles",
        code: "USER_MANAGE_ROLES",
        description: "Assign and remove user roles",
        resource: "user",
        action: "manage_roles",
        category: "USER",
        level: 50,
      },

      // Role permissions
      {
        name: "Read Roles",
        code: "ROLE_READ",
        description: "View role information",
        resource: "role",
        action: "read",
        category: "ROLE",
        level: 1,
      },
      {
        name: "Write Roles",
        code: "ROLE_WRITE",
        description: "Create and update roles",
        resource: "role",
        action: "write",
        category: "ROLE",
        level: 30,
      },
      {
        name: "Delete Roles",
        code: "ROLE_DELETE",
        description: "Delete roles",
        resource: "role",
        action: "delete",
        category: "ROLE",
        level: 60,
      },
      {
        name: "Assign Role Permissions",
        code: "ROLE_PERMISSION_ASSIGN",
        description: "Assign permissions to roles",
        resource: "role",
        action: "permission_assign",
        category: "ROLE",
        level: 40,
      },

      // Tenant permissions
      {
        name: "Read Tenants",
        code: "TENANT_READ",
        description: "View tenant information",
        resource: "tenant",
        action: "read",
        category: "TENANT",
        level: 1,
      },
      {
        name: "Write Tenants",
        code: "TENANT_WRITE",
        description: "Create and update tenants",
        resource: "tenant",
        action: "write",
        category: "TENANT",
        level: 80,
      },
      {
        name: "Delete Tenants",
        code: "TENANT_DELETE",
        description: "Delete tenants",
        resource: "tenant",
        action: "delete",
        category: "TENANT",
        level: 100,
      },

      // Portal permissions
      {
        name: "Portal Access",
        code: "PORTAL_ACCESS",
        description: "Access portal application",
        resource: "portal",
        action: "access",
        category: "PORTAL",
        level: 1,
      },
      {
        name: "Read Profile",
        code: "PORTAL_PROFILE_READ",
        description: "View own profile",
        resource: "portal",
        action: "profile_read",
        category: "PORTAL",
        level: 1,
      },
      {
        name: "Write Profile",
        code: "PORTAL_PROFILE_WRITE",
        description: "Update own profile",
        resource: "portal",
        action: "profile_write",
        category: "PORTAL",
        level: 10,
      },

      // CRM permissions
      {
        name: "CRM Access",
        code: "CRM_ACCESS",
        description: "Access CRM application",
        resource: "crm",
        action: "access",
        category: "CRM",
        level: 30,
      },
      {
        name: "Read Members",
        code: "CRM_MEMBER_READ",
        description: "View member information",
        resource: "crm",
        action: "member_read",
        category: "CRM",
        level: 30,
      },
      {
        name: "Write Members",
        code: "CRM_MEMBER_WRITE",
        description: "Create and update members",
        resource: "crm",
        action: "member_write",
        category: "CRM",
        level: 50,
      },
      {
        name: "Delete Members",
        code: "CRM_MEMBER_DELETE",
        description: "Delete members",
        resource: "crm",
        action: "member_delete",
        category: "CRM",
        level: 70,
      },

      // Admin permissions
      {
        name: "Admin Access",
        code: "ADMIN_ACCESS",
        description: "Access admin panel",
        resource: "admin",
        action: "access",
        category: "ADMIN",
        level: 80,
      },
      {
        name: "Admin Read",
        code: "ADMIN_READ",
        description: "View admin data",
        resource: "admin",
        action: "read",
        category: "ADMIN",
        level: 80,
      },
      {
        name: "Admin Write",
        code: "ADMIN_WRITE",
        description: "Modify admin data",
        resource: "admin",
        action: "write",
        category: "ADMIN",
        level: 90,
      },
      {
        name: "Admin Delete",
        code: "ADMIN_DELETE",
        description: "Delete admin data",
        resource: "admin",
        action: "delete",
        category: "ADMIN",
        level: 95,
      },

      // API permissions
      {
        name: "API Read",
        code: "API_READ",
        description: "Read API endpoints",
        resource: "api",
        action: "read",
        category: "API",
        level: 1,
      },
      {
        name: "API Write",
        code: "API_WRITE",
        description: "Write API endpoints",
        resource: "api",
        action: "write",
        category: "API",
        level: 30,
      },
      {
        name: "API Delete",
        code: "API_DELETE",
        description: "Delete API endpoints",
        resource: "api",
        action: "delete",
        category: "API",
        level: 60,
      },
    ];

    const permissionsWithSystemFlag = defaultPermissions.map((permission) => ({
      ...permission,
      isSystemPermission: true,
      createdBy: "system",
    }));

    const createdPermissions = await Permission.insertMany(
      permissionsWithSystemFlag
    );
    console.log(`Initialized ${createdPermissions.length} default permissions`);

    return createdPermissions;
  } catch (error) {
    throw new Error(`Error initializing permissions: ${error.message}`);
  }
};
