const mongoose = require("mongoose");
const { AppError } = require("../errors/AppError");
const TenantDepartmentHandler = require("../handlers/tenantDepartment.handler");

const resolveTenantId = (req) => {
  if (req.params.tenantId) {
    return req.params.tenantId;
  }
  return req.ctx?.tenantId || req.tenantId;
};

const assertValidTenantId = (tenantId, next) => {
  if (!tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) {
    next(AppError.badRequest("Valid tenant ID is required"));
    return false;
  }
  return true;
};

const mapHandlerError = (error, next) => {
  if (error?.statusCode === 400) {
    return next(AppError.badRequest(error.message));
  }
  if (error?.statusCode === 404) {
    return next(AppError.notFound(error.message));
  }
  if (error?.statusCode === 409) {
    return next(AppError.conflict(error.message));
  }
  console.error("Tenant department error:", error);
  return next(
    AppError.internalServerError("Tenant department operation failed")
  );
};

module.exports.getDepartments = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const includeInactive = req.query.includeInactive === "true";
    const publicOnly = req.query.publicOnly === "true";
    const departments = await TenantDepartmentHandler.listByTenant(tenantId, {
      includeInactive,
      publicOnly,
    });

    res.status(200).json({
      success: true,
      data: departments,
      count: departments.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.getDepartmentById = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const department = await TenantDepartmentHandler.getById(
      tenantId,
      req.params.id
    );
    if (!department) {
      return next(AppError.notFound("Department not found"));
    }

    res.status(200).json({
      success: true,
      data: department,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.createDepartment = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const department = await TenantDepartmentHandler.createDepartment(
      tenantId,
      req.body,
      userId
    );

    res.status(201).json({
      success: true,
      data: department,
      message: "Department created successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.updateDepartment = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const department = await TenantDepartmentHandler.updateDepartment(
      tenantId,
      req.params.id,
      req.body,
      userId
    );

    res.status(200).json({
      success: true,
      data: department,
      message: "Department updated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.deactivateDepartment = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const department = await TenantDepartmentHandler.deactivateDepartment(
      tenantId,
      req.params.id,
      userId
    );

    res.status(200).json({
      success: true,
      data: department,
      message: "Department deactivated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};
