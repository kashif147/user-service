const Tenant = require("../models/tenant");
const Role = require("../models/role");
const User = require("../models/user");

module.exports.createTenant = async (tenantData, createdBy) => {
  try {
    // Check if tenant code or domain already exists
    const existingTenant = await Tenant.findOne({
      $or: [{ code: tenantData.code }, { domain: tenantData.domain }],
    });

    if (existingTenant) {
      throw new Error("Tenant code or domain already exists");
    }

    const tenant = await Tenant.create({
      ...tenantData,
      createdBy,
    });

    // Initialize default roles for the new tenant
    await initializeTenantRoles(tenant._id.toString());

    return tenant;
  } catch (error) {
    throw new Error(`Error creating tenant: ${error.message}`);
  }
};

module.exports.getAllTenants = async (filters = {}) => {
  try {
    const query = { isActive: true };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.plan) {
      query["subscription.plan"] = filters.plan;
    }

    return await Tenant.find(query).sort({ createdAt: -1 }).select("-__v");
  } catch (error) {
    throw new Error(`Error fetching tenants: ${error.message}`);
  }
};

module.exports.getTenantById = async (tenantId) => {
  try {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }
    return tenant;
  } catch (error) {
    throw new Error(`Error fetching tenant: ${error.message}`);
  }
};

module.exports.getTenantByCode = async (code) => {
  try {
    const tenant = await Tenant.findOne({ code, isActive: true });
    if (!tenant) {
      throw new Error("Tenant not found");
    }
    return tenant;
  } catch (error) {
    throw new Error(`Error fetching tenant: ${error.message}`);
  }
};

module.exports.getTenantByDomain = async (domain) => {
  try {
    const tenant = await Tenant.findOne({ domain, isActive: true });
    if (!tenant) {
      throw new Error("Tenant not found");
    }
    return tenant;
  } catch (error) {
    throw new Error(`Error fetching tenant: ${error.message}`);
  }
};

module.exports.updateTenant = async (tenantId, updateData, updatedBy) => {
  try {
    const tenant = await Tenant.findByIdAndUpdate(
      tenantId,
      { ...updateData, updatedBy },
      { new: true, runValidators: true }
    );

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return tenant;
  } catch (error) {
    throw new Error(`Error updating tenant: ${error.message}`);
  }
};

module.exports.deleteTenant = async (tenantId) => {
  try {
    // Check if tenant has users
    const userCount = await User.countDocuments({ tenantId });
    if (userCount > 0) {
      throw new Error("Cannot delete tenant with existing users");
    }

    // Soft delete - mark as inactive
    const tenant = await Tenant.findByIdAndUpdate(
      tenantId,
      { isActive: false, status: "INACTIVE" },
      { new: true }
    );

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return { message: "Tenant deleted successfully" };
  } catch (error) {
    throw new Error(`Error deleting tenant: ${error.message}`);
  }
};

module.exports.getTenantStats = async (tenantId) => {
  try {
    const [userCount, roleCount, activeUsers] = await Promise.all([
      User.countDocuments({ tenantId }),
      Role.countDocuments({ tenantId }),
      User.countDocuments({ tenantId, isActive: true }),
    ]);

    return {
      totalUsers: userCount,
      activeUsers,
      totalRoles: roleCount,
      inactiveUsers: userCount - activeUsers,
    };
  } catch (error) {
    throw new Error(`Error fetching tenant stats: ${error.message}`);
  }
};

module.exports.updateTenantStatus = async (tenantId, status, updatedBy) => {
  try {
    const validStatuses = ["ACTIVE", "INACTIVE", "SUSPENDED", "PENDING"];
    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status");
    }

    const tenant = await Tenant.findByIdAndUpdate(
      tenantId,
      { status, updatedBy },
      { new: true }
    );

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return tenant;
  } catch (error) {
    throw new Error(`Error updating tenant status: ${error.message}`);
  }
};

// Authentication Connection Management Methods

module.exports.addAuthenticationConnection = async (
  tenantId,
  connectionData,
  updatedBy
) => {
  try {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    // Check if connection with same directory ID already exists
    const existingConnection = tenant.authenticationConnections.find(
      (conn) => conn.directoryId === connectionData.directoryId && conn.isActive
    );

    if (existingConnection) {
      throw new Error(
        "Authentication connection with this Directory ID already exists"
      );
    }

    // Add new connection
    tenant.authenticationConnections.push({
      ...connectionData,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    tenant.updatedBy = updatedBy;
    await tenant.save();

    return tenant;
  } catch (error) {
    throw new Error(`Error adding authentication connection: ${error.message}`);
  }
};

module.exports.updateAuthenticationConnection = async (
  tenantId,
  connectionId,
  updateData,
  updatedBy
) => {
  try {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const connection = tenant.authenticationConnections.id(connectionId);
    if (!connection) {
      throw new Error("Authentication connection not found");
    }

    // Check if updating directory ID would create a duplicate
    if (
      updateData.directoryId &&
      updateData.directoryId !== connection.directoryId
    ) {
      const existingConnection = tenant.authenticationConnections.find(
        (conn) =>
          conn.directoryId === updateData.directoryId &&
          conn._id.toString() !== connectionId &&
          conn.isActive
      );

      if (existingConnection) {
        throw new Error(
          "Authentication connection with this Directory ID already exists"
        );
      }
    }

    // Update connection
    Object.assign(connection, updateData);
    connection.updatedAt = new Date();
    tenant.updatedBy = updatedBy;

    await tenant.save();

    return tenant;
  } catch (error) {
    throw new Error(
      `Error updating authentication connection: ${error.message}`
    );
  }
};

module.exports.removeAuthenticationConnection = async (
  tenantId,
  connectionId,
  updatedBy
) => {
  try {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const connection = tenant.authenticationConnections.id(connectionId);
    if (!connection) {
      throw new Error("Authentication connection not found");
    }

    // Soft delete - mark as inactive
    connection.isActive = false;
    connection.updatedAt = new Date();
    tenant.updatedBy = updatedBy;

    await tenant.save();

    return tenant;
  } catch (error) {
    throw new Error(
      `Error removing authentication connection: ${error.message}`
    );
  }
};

module.exports.getAuthenticationConnections = async (tenantId) => {
  try {
    const tenant = await Tenant.findById(tenantId).select(
      "authenticationConnections"
    );
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return tenant.authenticationConnections.filter((conn) => conn.isActive);
  } catch (error) {
    throw new Error(
      `Error fetching authentication connections: ${error.message}`
    );
  }
};

// Helper function to initialize roles for a new tenant
const initializeTenantRoles = async (tenantId) => {
  try {
    // Check if roles already exist for this tenant
    const existingRoles = await Role.find({ tenantId });
    if (existingRoles.length > 0) {
      console.log(
        `Roles already exist for tenant ${tenantId} - Found ${existingRoles.length} roles`
      );
      return existingRoles;
    }

    // If no roles exist, copy roles from the main tenant
    const mainTenant = await Tenant.findOne({ code: "MAIN" });
    if (mainTenant) {
      const mainTenantRoles = await Role.find({
        tenantId: mainTenant._id.toString(),
      });

      if (mainTenantRoles.length > 0) {
        const rolesForNewTenant = mainTenantRoles.map((role) => ({
          name: role.name,
          code: role.code,
          description: role.description,
          userType: role.userType,
          permissions: role.permissions,
          isSystemRole: role.isSystemRole,
          tenantId: tenantId,
          createdBy: "system",
        }));

        const createdRoles = await Role.insertMany(rolesForNewTenant);
        console.log(
          `Initialized ${createdRoles.length} roles for tenant ${tenantId} (copied from main tenant)`
        );
        return createdRoles;
      }
    }

    console.log(
      `No roles found to initialize for tenant ${tenantId}. Please run migration script first.`
    );
    return [];
  } catch (error) {
    console.error(`Error initializing roles for tenant ${tenantId}:`, error);
    throw error;
  }
};
