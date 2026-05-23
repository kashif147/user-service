const mongoose = require("mongoose");
const Tenant = require("../models/tenant.model");
const Role = require("../models/role.model");
const User = require("../models/user.model");
const {
  normalizeOrganisationProfile,
  mergeOrganisationProfile,
} = require("../constants/tenantOrganisationDefaults");
const {
  mergeRegionalSettings,
  normalizeRegionalSettings,
  mergeSettings,
  normalizeSettings,
  mergeSubscription,
  normalizeSubscription,
} = require("../constants/tenantUpdateDefaults");

const buildTenantQuery = (tenantId) => {
  if (mongoose.Types.ObjectId.isValid(tenantId)) {
    return {
      $or: [
        { _id: tenantId },
        { "authenticationConnections.directoryId": tenantId },
      ],
    };
  }
  return { "authenticationConnections.directoryId": tenantId };
};

const flattenForMongoSet = (obj, prefix = "") => {
  const result = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !(value instanceof mongoose.Types.ObjectId)
    ) {
      Object.assign(result, flattenForMongoSet(value, path));
    } else {
      result[path] = value;
    }
  }
  return result;
};

const updateTenantSection = async (tenantId, prefix, sectionData, updatedBy) => {
  const setPayload = flattenForMongoSet(sectionData, prefix);
  if (Object.keys(setPayload).length === 0) {
    throw new Error("No valid fields provided for update");
  }

  const tenant = await Tenant.findOneAndUpdate(
    buildTenantQuery(tenantId),
    { $set: { ...setPayload, updatedBy } },
    { new: true, runValidators: true }
  );

  if (!tenant) {
    throw new Error("Tenant not found");
  }

  return tenant;
};

const toPlainSubdocument = (value) =>
  value?.toObject?.() ?? value ?? {};

const applyOrganisationProfileUpdate = async (
  tenantId,
  profilePatch,
  updatedBy
) => {
  const tenant = await Tenant.findOne(buildTenantQuery(tenantId));
  if (!tenant) {
    throw new Error("Tenant not found");
  }

  const merged = mergeOrganisationProfile(
    toPlainSubdocument(tenant.organisationProfile),
    profilePatch
  );
  const normalized = normalizeOrganisationProfile(merged);

  return updateTenantSection(
    tenantId,
    "organisationProfile",
    normalized,
    updatedBy
  );
};

const applyNestedTenantSections = (tenant, payload) => {
  if (payload.organisationProfile !== undefined) {
    payload.organisationProfile = normalizeOrganisationProfile(
      mergeOrganisationProfile(
        toPlainSubdocument(tenant.organisationProfile),
        payload.organisationProfile
      )
    );
  }

  if (payload.regionalSettings !== undefined) {
    payload.regionalSettings = normalizeRegionalSettings(
      mergeRegionalSettings(
        toPlainSubdocument(tenant.regionalSettings),
        payload.regionalSettings
      )
    );
  }

  if (payload.settings !== undefined) {
    payload.settings = normalizeSettings(
      mergeSettings(toPlainSubdocument(tenant.settings), payload.settings)
    );
  }

  if (payload.subscription !== undefined) {
    payload.subscription = normalizeSubscription(
      mergeSubscription(
        toPlainSubdocument(tenant.subscription),
        payload.subscription
      )
    );
  }

  return payload;
};

module.exports.createTenant = async (tenantData, createdBy) => {
  try {
    // Check if tenant code or domain already exists
    const existingTenant = await Tenant.findOne({
      $or: [{ code: tenantData.code }, { domain: tenantData.domain }],
    });

    if (existingTenant) {
      throw new Error("Tenant code or domain already exists");
    }

    const payload = { ...tenantData, createdBy };
    if (payload.organisationProfile) {
      payload.organisationProfile = normalizeOrganisationProfile(
        payload.organisationProfile
      );
    }
    if (payload.regionalSettings) {
      payload.regionalSettings = normalizeRegionalSettings(
        payload.regionalSettings
      );
    }
    if (payload.settings) {
      payload.settings = normalizeSettings(payload.settings);
    }
    if (payload.subscription) {
      payload.subscription = normalizeSubscription(payload.subscription);
    }

    const tenant = await Tenant.create(payload);

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
    const tenant = await Tenant.findOne(buildTenantQuery(tenantId));
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
    const tenant = await Tenant.findOne(buildTenantQuery(tenantId));
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const payload = {
      ...applyNestedTenantSections(tenant, updateData),
      updatedBy,
    };

    const updatedTenant = await Tenant.findOneAndUpdate(
      buildTenantQuery(tenantId),
      payload,
      { new: true, runValidators: true }
    );

    if (!updatedTenant) {
      throw new Error("Tenant not found");
    }

    return updatedTenant;
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
    const tenant = await Tenant.findOneAndUpdate(
      buildTenantQuery(tenantId),
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

    const tenant = await Tenant.findOneAndUpdate(
      buildTenantQuery(tenantId),
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
    const tenant = await Tenant.findOne(buildTenantQuery(tenantId));
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
    const tenant = await Tenant.findOne(buildTenantQuery(tenantId));
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
    const tenant = await Tenant.findOne(buildTenantQuery(tenantId));
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
    const tenant = await Tenant.findOne(buildTenantQuery(tenantId)).select(
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

module.exports.updateOrganisationProfile = async (
  tenantId,
  profileData,
  updatedBy
) => {
  try {
    return await applyOrganisationProfileUpdate(
      tenantId,
      profileData,
      updatedBy
    );
  } catch (error) {
    throw new Error(`Error updating organisation profile: ${error.message}`);
  }
};

module.exports.updateBranding = async (tenantId, brandingData, updatedBy) => {
  try {
    return await updateTenantSection(
      tenantId,
      "branding",
      brandingData,
      updatedBy
    );
  } catch (error) {
    throw new Error(`Error updating branding: ${error.message}`);
  }
};

module.exports.updateRegionalSettings = async (
  tenantId,
  regionalData,
  updatedBy
) => {
  try {
    const tenant = await Tenant.findOne(buildTenantQuery(tenantId));
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const normalized = normalizeRegionalSettings(
      mergeRegionalSettings(
        toPlainSubdocument(tenant.regionalSettings),
        regionalData
      )
    );

    return await updateTenantSection(
      tenantId,
      "regionalSettings",
      normalized,
      updatedBy
    );
  } catch (error) {
    throw new Error(`Error updating regional settings: ${error.message}`);
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
          category: role.category,
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
