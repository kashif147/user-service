const mongoose = require("mongoose");
const { AppError } = require("../errors/AppError");
const TenantContactHandler = require("../handlers/tenantContact.handler");

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

const assertValidDepartmentId = (departmentId, next) => {
  if (!departmentId || !mongoose.Types.ObjectId.isValid(departmentId)) {
    next(AppError.badRequest("Valid department ID is required"));
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
  console.error("Tenant contact error:", error);
  return next(AppError.internalServerError("Tenant contact operation failed"));
};

module.exports.getContacts = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    const departmentId = req.params.departmentId;
    if (!assertValidTenantId(tenantId, next)) return;
    if (!assertValidDepartmentId(departmentId, next)) return;

    const includeInactive = req.query.includeInactive === "true";
    const contacts = await TenantContactHandler.listByDepartment(
      tenantId,
      departmentId,
      { includeInactive }
    );

    res.status(200).json({
      success: true,
      data: contacts,
      count: contacts.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.getContactById = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    const { departmentId } = req.params;
    if (!assertValidTenantId(tenantId, next)) return;
    if (!assertValidDepartmentId(departmentId, next)) return;

    const contact = await TenantContactHandler.getById(
      tenantId,
      departmentId,
      req.params.id
    );
    if (!contact) {
      return next(AppError.notFound("Contact not found"));
    }

    res.status(200).json({
      success: true,
      data: contact,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.createContact = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    const { departmentId } = req.params;
    if (!assertValidTenantId(tenantId, next)) return;
    if (!assertValidDepartmentId(departmentId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const contact = await TenantContactHandler.createContact(
      tenantId,
      departmentId,
      req.body,
      userId
    );

    res.status(201).json({
      success: true,
      data: contact,
      message: "Contact created successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.updateContact = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    const { departmentId } = req.params;
    if (!assertValidTenantId(tenantId, next)) return;
    if (!assertValidDepartmentId(departmentId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const contact = await TenantContactHandler.updateContact(
      tenantId,
      departmentId,
      req.params.id,
      req.body,
      userId
    );

    res.status(200).json({
      success: true,
      data: contact,
      message: "Contact updated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.setPrimaryContact = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    const { departmentId } = req.params;
    if (!assertValidTenantId(tenantId, next)) return;
    if (!assertValidDepartmentId(departmentId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const contact = await TenantContactHandler.setPrimaryContact(
      tenantId,
      departmentId,
      req.params.id,
      userId
    );

    res.status(200).json({
      success: true,
      data: contact,
      message: "Primary contact updated",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};

module.exports.deactivateContact = async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    const { departmentId } = req.params;
    if (!assertValidTenantId(tenantId, next)) return;
    if (!assertValidDepartmentId(departmentId, next)) return;

    const userId = req.ctx?.userId || req.user?.id || null;
    const contact = await TenantContactHandler.deactivateContact(
      tenantId,
      departmentId,
      req.params.id,
      userId
    );

    res.status(200).json({
      success: true,
      data: contact,
      message: "Contact deactivated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    mapHandlerError(error, next);
  }
};
