const TenantHandler = require("../handlers/tenant.handler");
const { AppError } = require("../errors/AppError");
const { hasRole } = require("../middlewares/auth");
const {
  pickOrganisationProfilePayload,
} = require("../constants/tenantOrganisationDefaults");
const {
  pickRegionalSettingsPayload,
} = require("../constants/tenantUpdateDefaults");

// Phase 1C-2B: non-SU lookups are confined to the caller's trusted tenant (req.ctx), never a
// caller-supplied value. SU (from trusted roles) is unrestricted.
const ownTenantScope = (req) =>
  hasRole(req.ctx?.roles, "SU") ? {} : { ownTenantId: String(req.ctx?.tenantId || "") || "__none__" };

// Create tenant
module.exports.createTenant = async (req, res, next) => {
  try {
    const createdBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.createTenant(req.body, createdBy);
    res.status(201).json({ status: "success", data: tenant });
  } catch (error) {
    return next(AppError.internalServerError("Failed to create tenant"));
  }
};

// Get all tenants
module.exports.getAllTenants = async (req, res, next) => {
  try {
    const filters = {
      status: req.query.status,
      plan: req.query.plan,
    };
    // Phase 1C-2B: only SU (from trusted roles) lists every tenant; everyone else gets their own
    // tenant only, from the trusted req.ctx.tenantId — never a caller-supplied filter.
    if (!hasRole(req.ctx?.roles, "SU")) {
      if (!req.ctx?.tenantId) {
        return next(AppError.forbidden("Tenant context required"));
      }
      filters.ownTenantId = String(req.ctx.tenantId);
    }
    const tenants = await TenantHandler.getAllTenants(filters);
    res.status(200).json({ status: "success", data: tenants });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve tenants"));
  }
};

// Get tenant by ID
module.exports.getTenantById = async (req, res, next) => {
  try {
    const tenant = await TenantHandler.getTenantById(req.params.id);
    if (!tenant) {
      return next(AppError.notFound("Tenant not found"));
    }
    res.status(200).json({ status: "success", data: tenant });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve tenant"));
  }
};

// Get tenant by code
module.exports.getTenantByCode = async (req, res, next) => {
  try {
    const tenant = await TenantHandler.getTenantByCode(req.params.code, ownTenantScope(req));
    if (!tenant) {
      return next(AppError.notFound("Tenant not found"));
    }
    res.status(200).json({ status: "success", data: tenant });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve tenant"));
  }
};

// Get tenant by domain
module.exports.getTenantByDomain = async (req, res, next) => {
  try {
    const tenant = await TenantHandler.getTenantByDomain(req.params.domain, ownTenantScope(req));
    if (!tenant) {
      return next(AppError.notFound("Tenant not found"));
    }
    res.status(200).json({ status: "success", data: tenant });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve tenant"));
  }
};

// Update tenant
module.exports.updateTenant = async (req, res, next) => {
  try {
    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.updateTenant(
      req.params.id,
      req.body,
      updatedBy
    );
    if (!tenant) {
      return next(AppError.notFound("Tenant not found"));
    }
    res.status(200).json({ status: "success", data: tenant });
  } catch (error) {
    return next(AppError.internalServerError("Failed to update tenant"));
  }
};

// Delete tenant
module.exports.deleteTenant = async (req, res, next) => {
  try {
    const result = await TenantHandler.deleteTenant(req.params.id);
    if (!result) {
      return next(AppError.notFound("Tenant not found"));
    }
    res.status(200).json({ status: "success", data: result.message });
  } catch (error) {
    return next(AppError.internalServerError("Failed to delete tenant"));
  }
};

// Phase 1C-2Q: the functions below used to call res.fail(), which response.mw.js never defined;
// each error path crashed the process. They now use response.mw.js helpers with the tenant API's
// existing conventions (not found -> 404, bad input -> 400, otherwise a generic 500).

// Get tenant statistics
module.exports.getTenantStats = async (req, res) => {
  try {
    const stats = await TenantHandler.getTenantStats(req.params.id);
    res.success(stats);
  } catch (error) {
    console.error("[tenant]", error.message);
    return res.sendInternalError("Failed to retrieve tenant stats");
  }
};

// Update tenant status
module.exports.updateTenantStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.updateTenantStatus(
      req.params.id,
      status,
      updatedBy
    );
    res.success(tenant);
  } catch (error) {
    if ((error.message || "").includes("Invalid status")) {
      return res.sendBadRequest("Invalid status");
    }
    if ((error.message || "").includes("Tenant not found")) {
      return res.sendNotFound("Tenant not found");
    }
    console.error("[tenant]", error.message);
    return res.sendInternalError("Failed to update tenant status");
  }
};

// Authentication Connection Management Controllers

// Add authentication connection
module.exports.addAuthenticationConnection = async (req, res) => {
  try {
    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.addAuthenticationConnection(
      req.params.id,
      req.body,
      updatedBy
    );
    res.success(tenant);
  } catch (error) {
    if ((error.message || "").includes("Tenant not found")) {
      return res.sendNotFound("Tenant not found");
    }
    if ((error.message || "").includes("Directory ID already exists")) {
      return res.sendBadRequest("Authentication connection with this Directory ID already exists");
    }
    console.error("[tenant]", error.message);
    return res.sendInternalError("Failed to add authentication connection");
  }
};

// Update authentication connection
module.exports.updateAuthenticationConnection = async (req, res) => {
  try {
    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.updateAuthenticationConnection(
      req.params.id,
      req.params.connectionId,
      req.body,
      updatedBy
    );
    res.success(tenant);
  } catch (error) {
    if ((error.message || "").includes("Tenant not found")) {
      return res.sendNotFound("Tenant not found");
    }
    if ((error.message || "").includes("Authentication connection not found")) {
      return res.sendNotFound("Authentication connection not found");
    }
    if ((error.message || "").includes("Directory ID already exists")) {
      return res.sendBadRequest("Authentication connection with this Directory ID already exists");
    }
    console.error("[tenant]", error.message);
    return res.sendInternalError("Failed to update authentication connection");
  }
};

// Remove authentication connection
module.exports.removeAuthenticationConnection = async (req, res) => {
  try {
    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.removeAuthenticationConnection(
      req.params.id,
      req.params.connectionId,
      updatedBy
    );
    res.success(tenant);
  } catch (error) {
    if ((error.message || "").includes("Tenant not found")) {
      return res.sendNotFound("Tenant not found");
    }
    if ((error.message || "").includes("Authentication connection not found")) {
      return res.sendNotFound("Authentication connection not found");
    }
    console.error("[tenant]", error.message);
    return res.sendInternalError("Failed to remove authentication connection");
  }
};

// Get authentication connections
module.exports.getAuthenticationConnections = async (req, res) => {
  try {
    const connections = await TenantHandler.getAuthenticationConnections(
      req.params.id
    );
    res.success(connections);
  } catch (error) {
    if ((error.message || "").includes("Tenant not found")) {
      return res.sendNotFound("Tenant not found");
    }
    console.error("[tenant]", error.message);
    return res.sendInternalError("Failed to retrieve authentication connections");
  }
};

module.exports.updateOrganisationProfile = async (req, res, next) => {
  try {
    const profileData = pickOrganisationProfilePayload(req.body);
    if (Object.keys(profileData).length === 0) {
      return next(
        AppError.badRequest("No valid organisation profile fields provided")
      );
    }

    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.updateOrganisationProfile(
      req.params.id,
      profileData,
      updatedBy
    );
    res.status(200).json({ status: "success", data: tenant });
  } catch (error) {
    if (error.message === "Tenant not found") {
      return next(AppError.notFound("Tenant not found"));
    }
    return next(AppError.internalServerError("Failed to update organisation profile"));
  }
};

module.exports.updateBranding = async (req, res, next) => {
  try {
    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.updateBranding(
      req.params.id,
      req.body,
      updatedBy
    );
    res.status(200).json({ status: "success", data: tenant });
  } catch (error) {
    return next(AppError.internalServerError("Failed to update branding"));
  }
};

module.exports.updateRegionalSettings = async (req, res, next) => {
  try {
    const regionalData = pickRegionalSettingsPayload(req.body);
    if (Object.keys(regionalData).length === 0) {
      return next(
        AppError.badRequest("No valid regional settings fields provided")
      );
    }

    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.updateRegionalSettings(
      req.params.id,
      regionalData,
      updatedBy
    );
    res.status(200).json({ status: "success", data: tenant });
  } catch (error) {
    if (error.message === "Tenant not found") {
      return next(AppError.notFound("Tenant not found"));
    }
    return next(AppError.internalServerError("Failed to update regional settings"));
  }
};
