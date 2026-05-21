const mongoose = require("mongoose");
const { AppError } = require("../errors/AppError");
const TenantOfficeHandler = require("../handlers/tenantOffice.handler");

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
  console.error("Tenant office error:", error);
  return next(AppError.internalServerError("Tenant office operation failed"));
};

module.exports.getOffices = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const includeInactive = req.query.includeInactive === "true";
    const offices = await TenantOfficeHandler.listByTenant(tenantId, {
      includeInactive,
    });

    res.status(200).json({
      success: true,
      data: offices,
      count: offices.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.getOfficeById = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const office = await TenantOfficeHandler.getById(tenantId, req.params.id);
    if (!office) {
      return next(AppError.notFound("Office not found"));
    }

    res.status(200).json({
      success: true,
      data: office,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.getOfficeDefaults = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        openingHours: TenantOfficeHandler.buildDefaultOpeningHours(),
        officeTypes: TenantOfficeHandler.OFFICE_TYPES,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.createOffice = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const office = await TenantOfficeHandler.createOffice(
      tenantId,
      req.body,
      userId
    );

    res.status(201).json({
      success: true,
      data: office,
      message: "Office created successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.updateOffice = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const office = await TenantOfficeHandler.updateOffice(
      tenantId,
      req.params.id,
      req.body,
      userId
    );

    res.status(200).json({
      success: true,
      data: office,
      message: "Office updated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.setPrimaryOffice = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const office = await TenantOfficeHandler.setPrimaryOffice(
      tenantId,
      req.params.id,
      userId
    );

    res.status(200).json({
      success: true,
      data: office,
      message: "Primary office updated",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.deactivateOffice = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const office = await TenantOfficeHandler.deactivateOffice(
      tenantId,
      req.params.id,
      userId
    );

    res.status(200).json({
      success: true,
      data: office,
      message: "Office deactivated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};
