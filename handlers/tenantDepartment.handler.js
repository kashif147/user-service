const mongoose = require("mongoose");
const TenantDepartment = require("../models/tenantDepartment.model");

const normalizeCode = (code) => code?.trim().toUpperCase() || "";

const listByTenant = async (
  tenantId,
  { includeInactive = false, publicOnly = false } = {}
) => {
  const query = { tenantId };
  if (!includeInactive) {
    query.isActive = true;
  }
  if (publicOnly) {
    query.isPublic = true;
  }
  return TenantDepartment.find(query).sort({ displayOrder: 1, name: 1 });
};

const getById = async (tenantId, departmentId) => {
  if (!mongoose.Types.ObjectId.isValid(departmentId)) {
    return null;
  }
  return TenantDepartment.findOne({ _id: departmentId, tenantId });
};

const createDepartment = async (tenantId, payload, userId) => {
  const {
    name,
    code,
    description,
    email,
    phone,
    displayOrder = 0,
    isPublic = true,
    isActive = true,
  } = payload;

  if (!name?.trim()) {
    const err = new Error("Department name is required");
    err.statusCode = 400;
    throw err;
  }

  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) {
    const err = new Error("Department code is required");
    err.statusCode = 400;
    throw err;
  }

  try {
    return await TenantDepartment.create({
      tenantId,
      name: name.trim(),
      code: normalizedCode,
      description: description?.trim() || undefined,
      email: email?.trim() || undefined,
      phone: phone?.trim() || undefined,
      displayOrder: Number.isFinite(Number(displayOrder))
        ? Number(displayOrder)
        : 0,
      isPublic: isPublic !== false,
      isActive: isActive !== false,
      createdBy: userId || null,
      updatedBy: userId || null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      const err = new Error("Department code already exists for this tenant");
      err.statusCode = 409;
      throw err;
    }
    throw error;
  }
};

const updateDepartment = async (tenantId, departmentId, payload, userId) => {
  const department = await getById(tenantId, departmentId);
  if (!department) {
    const err = new Error("Department not found");
    err.statusCode = 404;
    throw err;
  }

  const fields = [
    "name",
    "code",
    "description",
    "email",
    "phone",
    "displayOrder",
    "isPublic",
    "isActive",
  ];

  for (const field of fields) {
    if (payload[field] === undefined) continue;

    if (field === "name") {
      if (!payload.name?.trim()) {
        const err = new Error("Department name is required");
        err.statusCode = 400;
        throw err;
      }
      department.name = payload.name.trim();
    } else if (field === "code") {
      const normalizedCode = normalizeCode(payload.code);
      if (!normalizedCode) {
        const err = new Error("Department code is required");
        err.statusCode = 400;
        throw err;
      }
      department.code = normalizedCode;
    } else if (field === "description") {
      department.description = payload.description?.trim() || undefined;
    } else if (field === "email") {
      department.email = payload.email?.trim() || undefined;
    } else if (field === "phone") {
      department.phone = payload.phone?.trim() || undefined;
    } else if (field === "displayOrder") {
      department.displayOrder = Number.isFinite(Number(payload.displayOrder))
        ? Number(payload.displayOrder)
        : 0;
    } else if (field === "isPublic") {
      department.isPublic = Boolean(payload.isPublic);
    } else if (field === "isActive") {
      department.isActive = Boolean(payload.isActive);
    }
  }

  department.updatedBy = userId || department.updatedBy;

  try {
    await department.save();
    return TenantDepartment.findById(department._id);
  } catch (error) {
    if (error?.code === 11000) {
      const err = new Error("Department code already exists for this tenant");
      err.statusCode = 409;
      throw err;
    }
    throw error;
  }
};

const deactivateDepartment = async (tenantId, departmentId, userId) => {
  const department = await getById(tenantId, departmentId);
  if (!department) {
    const err = new Error("Department not found");
    err.statusCode = 404;
    throw err;
  }

  department.isActive = false;
  department.updatedBy = userId || department.updatedBy;
  await department.save();
  return department;
};

module.exports = {
  listByTenant,
  getById,
  createDepartment,
  updateDepartment,
  deactivateDepartment,
};
