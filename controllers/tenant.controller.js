const TenantHandler = require("../handlers/tenant.handler");

// Create tenant
module.exports.createTenant = async (req, res) => {
  try {
    const createdBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.createTenant(req.body, createdBy);
    res.success(tenant);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get all tenants
module.exports.getAllTenants = async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      plan: req.query.plan,
    };
    const tenants = await TenantHandler.getAllTenants(filters);
    res.success(tenants);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get tenant by ID
module.exports.getTenantById = async (req, res) => {
  try {
    const tenant = await TenantHandler.getTenantById(req.params.id);
    res.success(tenant);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get tenant by code
module.exports.getTenantByCode = async (req, res) => {
  try {
    const tenant = await TenantHandler.getTenantByCode(req.params.code);
    res.success(tenant);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get tenant by domain
module.exports.getTenantByDomain = async (req, res) => {
  try {
    const tenant = await TenantHandler.getTenantByDomain(req.params.domain);
    res.success(tenant);
  } catch (error) {
    res.fail(error.message);
  }
};

// Update tenant
module.exports.updateTenant = async (req, res) => {
  try {
    const updatedBy = req.ctx?.userId || "system";
    const tenant = await TenantHandler.updateTenant(
      req.params.id,
      req.body,
      updatedBy
    );
    res.success(tenant);
  } catch (error) {
    res.fail(error.message);
  }
};

// Delete tenant
module.exports.deleteTenant = async (req, res) => {
  try {
    const result = await TenantHandler.deleteTenant(req.params.id);
    res.success(result.message);
  } catch (error) {
    res.fail(error.message);
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
