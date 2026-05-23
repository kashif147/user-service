const mongoose = require("mongoose");
const TenantContact = require("../models/tenantContact.model");
const TenantDepartmentHandler = require("./tenantDepartment.handler");

const assertDepartment = async (tenantId, departmentId) => {
  const department = await TenantDepartmentHandler.getById(
    tenantId,
    departmentId
  );
  if (!department) {
    const err = new Error("Department not found");
    err.statusCode = 404;
    throw err;
  }
  return department;
};

const clearPrimaryForDepartment = async (
  tenantId,
  departmentId,
  exceptContactId = null
) => {
  const query = { tenantId, departmentId, isPrimaryContact: true };
  if (exceptContactId) {
    query._id = { $ne: exceptContactId };
  }
  await TenantContact.updateMany(query, { $set: { isPrimaryContact: false } });
};

const ensureSinglePrimary = async (
  tenantId,
  departmentId,
  contactId,
  isPrimary
) => {
  if (!isPrimary) return;
  await clearPrimaryForDepartment(tenantId, departmentId, contactId);
};

const listByDepartment = async (
  tenantId,
  departmentId,
  { includeInactive = false } = {}
) => {
  await assertDepartment(tenantId, departmentId);
  const query = { tenantId, departmentId };
  if (!includeInactive) {
    query.isActive = true;
  }
  return TenantContact.find(query).sort({
    isPrimaryContact: -1,
    displayOrder: 1,
    fullName: 1,
  });
};

const getById = async (tenantId, departmentId, contactId) => {
  if (!mongoose.Types.ObjectId.isValid(contactId)) {
    return null;
  }
  await assertDepartment(tenantId, departmentId);
  return TenantContact.findOne({
    _id: contactId,
    tenantId,
    departmentId,
  });
};

const createContact = async (tenantId, departmentId, payload, userId) => {
  await assertDepartment(tenantId, departmentId);

  const {
    fullName,
    roleTitle,
    email,
    phone,
    mobile,
    isPrimaryContact = false,
    displayOrder = 0,
    isActive = true,
  } = payload;

  if (!fullName?.trim()) {
    const err = new Error("Contact full name is required");
    err.statusCode = 400;
    throw err;
  }

  const contact = await TenantContact.create({
    tenantId,
    departmentId,
    fullName: fullName.trim(),
    roleTitle: roleTitle?.trim() || undefined,
    email: email?.trim() || undefined,
    phone: phone?.trim() || undefined,
    mobile: mobile?.trim() || undefined,
    isPrimaryContact: Boolean(isPrimaryContact),
    displayOrder: Number.isFinite(Number(displayOrder))
      ? Number(displayOrder)
      : 0,
    isActive: isActive !== false,
    createdBy: userId || null,
    updatedBy: userId || null,
  });

  if (contact.isPrimaryContact) {
    await ensureSinglePrimary(
      tenantId,
      departmentId,
      contact._id,
      true
    );
  } else {
    const primaryCount = await TenantContact.countDocuments({
      tenantId,
      departmentId,
      isPrimaryContact: true,
      isActive: true,
    });
    if (primaryCount === 0) {
      contact.isPrimaryContact = true;
      await contact.save();
    }
  }

  return TenantContact.findById(contact._id);
};

const updateContact = async (
  tenantId,
  departmentId,
  contactId,
  payload,
  userId
) => {
  const contact = await getById(tenantId, departmentId, contactId);
  if (!contact) {
    const err = new Error("Contact not found");
    err.statusCode = 404;
    throw err;
  }

  const fields = [
    "fullName",
    "roleTitle",
    "email",
    "phone",
    "mobile",
    "isPrimaryContact",
    "displayOrder",
    "isActive",
  ];

  for (const field of fields) {
    if (payload[field] === undefined) continue;

    if (field === "fullName") {
      if (!payload.fullName?.trim()) {
        const err = new Error("Contact full name is required");
        err.statusCode = 400;
        throw err;
      }
      contact.fullName = payload.fullName.trim();
    } else if (field === "roleTitle") {
      contact.roleTitle = payload.roleTitle?.trim() || undefined;
    } else if (field === "email") {
      contact.email = payload.email?.trim() || undefined;
    } else if (field === "phone") {
      contact.phone = payload.phone?.trim() || undefined;
    } else if (field === "mobile") {
      contact.mobile = payload.mobile?.trim() || undefined;
    } else if (field === "displayOrder") {
      contact.displayOrder = Number.isFinite(Number(payload.displayOrder))
        ? Number(payload.displayOrder)
        : 0;
    } else if (field === "isPrimaryContact") {
      contact.isPrimaryContact = Boolean(payload.isPrimaryContact);
    } else if (field === "isActive") {
      contact.isActive = Boolean(payload.isActive);
    }
  }

  contact.updatedBy = userId || contact.updatedBy;
  await contact.save();

  if (contact.isPrimaryContact) {
    await ensureSinglePrimary(
      tenantId,
      departmentId,
      contact._id,
      true
    );
  }

  return TenantContact.findById(contact._id);
};

const setPrimaryContact = async (
  tenantId,
  departmentId,
  contactId,
  userId
) => {
  const contact = await getById(tenantId, departmentId, contactId);
  if (!contact) {
    const err = new Error("Contact not found");
    err.statusCode = 404;
    throw err;
  }

  contact.isPrimaryContact = true;
  contact.isActive = true;
  contact.updatedBy = userId || contact.updatedBy;
  await contact.save();
  await ensureSinglePrimary(tenantId, departmentId, contact._id, true);
  return TenantContact.findById(contact._id);
};

const deactivateContact = async (
  tenantId,
  departmentId,
  contactId,
  userId
) => {
  const contact = await getById(tenantId, departmentId, contactId);
  if (!contact) {
    const err = new Error("Contact not found");
    err.statusCode = 404;
    throw err;
  }

  const wasPrimary = contact.isPrimaryContact;
  contact.isActive = false;
  contact.isPrimaryContact = false;
  contact.updatedBy = userId || contact.updatedBy;
  await contact.save();

  if (wasPrimary) {
    const nextPrimary = await TenantContact.findOne({
      tenantId,
      departmentId,
      isActive: true,
      _id: { $ne: contact._id },
    }).sort({ displayOrder: 1, createdAt: 1 });
    if (nextPrimary) {
      await setPrimaryContact(tenantId, departmentId, nextPrimary._id, userId);
    }
  }

  return contact;
};

module.exports = {
  listByDepartment,
  getById,
  createContact,
  updateContact,
  setPrimaryContact,
  deactivateContact,
};
