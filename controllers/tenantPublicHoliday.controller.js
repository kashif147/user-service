const mongoose = require("mongoose");
const { AppError } = require("../errors/AppError");
const TenantPublicHolidayHandler = require("../handlers/tenantPublicHoliday.handler");

const resolveTenantId = (req) => req.params.tenantId || req.ctx?.tenantId || req.tenantId;

const assertValidTenantId = (tenantId, next) => {
  if (!tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) {
    next(AppError.badRequest("Valid tenant ID is required"));
    return false;
  }
  return true;
};

const mapHandlerError = (error, next) => {
  if (error?.statusCode === 400) return next(AppError.badRequest(error.message));
  if (error?.statusCode === 404) return next(AppError.notFound(error.message));
  console.error("Tenant public holiday error:", error);
  return next(AppError.internalServerError("Tenant public holiday operation failed"));
};

module.exports.getPublicHolidays = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;
    const holidays = await TenantPublicHolidayHandler.listByTenant(tenantId, {
      includeInactive: req.query.includeInactive === "true",
      from: req.query.from || null,
      to: req.query.to || null,
    });
    res.status(200).json({
      success: true,
      data: holidays,
      count: holidays.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.createPublicHoliday = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;
    const holiday = await TenantPublicHolidayHandler.createHoliday(
      tenantId,
      req.body,
      req.ctx?.userId || req.user?.id || null
    );
    res.status(201).json({
      success: true,
      data: holiday,
      message: "Public holiday created successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.updatePublicHoliday = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;
    const holiday = await TenantPublicHolidayHandler.updateHoliday(
      tenantId,
      req.params.id,
      req.body,
      req.ctx?.userId || req.user?.id || null
    );
    res.status(200).json({
      success: true,
      data: holiday,
      message: "Public holiday updated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.deactivatePublicHoliday = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!assertValidTenantId(tenantId, next)) return;
    const holiday = await TenantPublicHolidayHandler.deactivateHoliday(
      tenantId,
      req.params.id,
      req.ctx?.userId || req.user?.id || null
    );
    res.status(200).json({
      success: true,
      data: holiday,
      message: "Public holiday deactivated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};
