const TenantHandler = require("../handlers/tenant.handler");
const { AppError } = require("../errors/AppError");

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
    const tenant = await TenantHandler.getTenantByCode(req.params.code);
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
    const tenant = await TenantHandler.getTenantByDomain(req.params.domain);
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

// Get tenant statistics
module.exports.getTenantStats = async (req, res) => {
  try {
    const stats = await TenantHandler.getTenantStats(req.params.id);
    res.success(stats);
  } catch (error) {
    res.fail(error.message);
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
    res.fail(error.message);
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
    res.fail(error.message);
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
    res.fail(error.message);
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
    res.fail(error.message);
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
    res.fail(error.message);
  }
};
