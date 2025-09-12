const PermissionHandler = require("../handlers/permission.handler");

// Create permission
module.exports.createPermission = async (req, res) => {
  try {
    const createdBy = req.ctx?.userId || "system";
    const permission = await PermissionHandler.createPermission(
      req.body,
      createdBy
    );
    res.success(permission);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get all permissions
module.exports.getAllPermissions = async (req, res) => {
  try {
    const filters = {
      category: req.query.category,
      resource: req.query.resource,
      level: req.query.level,
    };
    const permissions = await PermissionHandler.getAllPermissions(filters);
    res.success(permissions);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get permission by ID
module.exports.getPermissionById = async (req, res) => {
  try {
    const permission = await PermissionHandler.getPermissionById(req.params.id);
    res.success(permission);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get permission by code
module.exports.getPermissionByCode = async (req, res) => {
  try {
    const permission = await PermissionHandler.getPermissionByCode(
      req.params.code
    );
    res.success(permission);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get permissions by resource
module.exports.getPermissionsByResource = async (req, res) => {
  try {
    const permissions = await PermissionHandler.getPermissionsByResource(
      req.params.resource
    );
    res.success(permissions);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get permissions by category
module.exports.getPermissionsByCategory = async (req, res) => {
  try {
    const permissions = await PermissionHandler.getPermissionsByCategory(
      req.params.category
    );
    res.success(permissions);
  } catch (error) {
    res.fail(error.message);
  }
};

// Update permission
module.exports.updatePermission = async (req, res) => {
  try {
    const updatedBy = req.ctx?.userId || "system";
    const permission = await PermissionHandler.updatePermission(
      req.params.id,
      req.body,
      updatedBy
    );
    res.success(permission);
  } catch (error) {
    res.fail(error.message);
  }
};

// Delete permission
module.exports.deletePermission = async (req, res) => {
  try {
    const result = await PermissionHandler.deletePermission(req.params.id);
    res.success(result.message);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get permission statistics
module.exports.getPermissionStats = async (req, res) => {
  try {
    const stats = await PermissionHandler.getPermissionStats();
    res.success(stats);
  } catch (error) {
    res.fail(error.message);
  }
};

// Initialize default permissions
module.exports.initializeDefaultPermissions = async (req, res) => {
  try {
    const permissions = await PermissionHandler.initializeDefaultPermissions();
    res.success(permissions);
  } catch (error) {
    res.fail(error.message);
  }
};
