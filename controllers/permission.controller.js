const PermissionHandler = require("../handlers/permission.handler");
const { AppError } = require("../errors/AppError");

// Create permission
module.exports.createPermission = async (req, res, next) => {
  try {
    const createdBy = req.ctx?.userId || "system";
    const permission = await PermissionHandler.createPermission(
      req.body,
      createdBy
    );
    res.status(201).json({ status: "success", data: permission });
  } catch (error) {
    return next(AppError.internalServerError("Failed to create permission"));
  }
};

// Get all permissions
module.exports.getAllPermissions = async (req, res, next) => {
  try {
    const filters = {
      category: req.query.category,
      resource: req.query.resource,
      level: req.query.level,
    };
    const permissions = await PermissionHandler.getAllPermissions(filters);
    res.status(200).json({ status: "success", data: permissions });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve permissions"));
  }
};

// Get permission by ID
module.exports.getPermissionById = async (req, res, next) => {
  try {
    const permission = await PermissionHandler.getPermissionById(req.params.id);
    if (!permission) {
      return next(AppError.notFound("Permission not found"));
    }
    res.status(200).json({ status: "success", data: permission });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve permission"));
  }
};

// Get permission by code
module.exports.getPermissionByCode = async (req, res, next) => {
  try {
    const permission = await PermissionHandler.getPermissionByCode(
      req.params.code
    );
    if (!permission) {
      return next(AppError.notFound("Permission not found"));
    }
    res.status(200).json({ status: "success", data: permission });
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve permission"));
  }
};

// Get permissions by resource
module.exports.getPermissionsByResource = async (req, res, next) => {
  try {
    const permissions = await PermissionHandler.getPermissionsByResource(
      req.params.resource
    );
    res.status(200).json({ status: "success", data: permissions });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to retrieve permissions by resource")
    );
  }
};

// Get permissions by category
module.exports.getPermissionsByCategory = async (req, res, next) => {
  try {
    const permissions = await PermissionHandler.getPermissionsByCategory(
      req.params.category
    );
    res.status(200).json({ status: "success", data: permissions });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to retrieve permissions by category")
    );
  }
};

// Update permission
module.exports.updatePermission = async (req, res, next) => {
  try {
    const updatedBy = req.ctx?.userId || "system";
    const permission = await PermissionHandler.updatePermission(
      req.params.id,
      req.body,
      updatedBy
    );
    if (!permission) {
      return next(AppError.notFound("Permission not found"));
    }
    res.status(200).json({ status: "success", data: permission });
  } catch (error) {
    return next(AppError.internalServerError("Failed to update permission"));
  }
};

// Delete permission
module.exports.deletePermission = async (req, res, next) => {
  try {
    const result = await PermissionHandler.deletePermission(req.params.id);
    if (!result) {
      return next(AppError.notFound("Permission not found"));
    }
    res.status(200).json({ status: "success", data: result.message });
  } catch (error) {
    return next(AppError.internalServerError("Failed to delete permission"));
  }
};

// Get permission statistics
module.exports.getPermissionStats = async (req, res, next) => {
  try {
    const stats = await PermissionHandler.getPermissionStats();
    res.status(200).json({ status: "success", data: stats });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to retrieve permission statistics")
    );
  }
};

// Initialize default permissions
module.exports.initializeDefaultPermissions = async (req, res, next) => {
  try {
    const permissions = await PermissionHandler.initializeDefaultPermissions();
    res.status(200).json({ status: "success", data: permissions });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to initialize default permissions")
    );
  }
};
