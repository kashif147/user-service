const mongoose = require("mongoose");
const TenantOffice = require("../models/tenantOffice.model");
const {
  defaultAddress,
  normalizeOpeningHours,
  normalizeNonWorkingDays,
  buildDefaultOpeningHours,
} = require("../constants/tenantOfficeDefaults");

const OFFICE_TYPES = ["HEAD_OFFICE", "BRANCH", "REGIONAL_OFFICE"];

const normalizeAddress = (address = {}) => ({
  ...defaultAddress(),
  buildingOrHouse: address.buildingOrHouse?.trim() || "",
  streetOrRoad: address.streetOrRoad?.trim() || "",
  areaOrTown: address.areaOrTown?.trim() || "",
  countyCityOrPostCode: address.countyCityOrPostCode?.trim() || "",
  eircode: address.eircode?.trim() || "",
  country: address.country?.trim() || "Ireland",
});

const clearPrimaryForTenant = async (tenantId, exceptOfficeId = null) => {
  const query = { tenantId, isPrimary: true };
  if (exceptOfficeId) {
    query._id = { $ne: exceptOfficeId };
  }
  await TenantOffice.updateMany(query, { $set: { isPrimary: false } });
};

const ensureSinglePrimary = async (tenantId, officeId, isPrimary) => {
  if (!isPrimary) return;
  await clearPrimaryForTenant(tenantId, officeId);
};

const listByTenant = async (tenantId, { includeInactive = false } = {}) => {
  const query = { tenantId };
  if (!includeInactive) {
    query.isActive = true;
  }
  return TenantOffice.find(query).sort({ isPrimary: -1, name: 1 });
};

const getById = async (tenantId, officeId) => {
  if (!mongoose.Types.ObjectId.isValid(officeId)) {
    return null;
  }
  return TenantOffice.findOne({ _id: officeId, tenantId });
};

const createOffice = async (tenantId, payload, userId) => {
  const {
    name,
    officeType = "BRANCH",
    address,
    email,
    phone,
    openingHours,
    nonWorkingDays,
    isPrimary = false,
    isActive = true,
  } = payload;

  if (!name?.trim()) {
    const err = new Error("Office name is required");
    err.statusCode = 400;
    throw err;
  }

  if (!OFFICE_TYPES.includes(officeType)) {
    const err = new Error("Invalid office type");
    err.statusCode = 400;
    throw err;
  }

  const office = await TenantOffice.create({
    tenantId,
    name: name.trim(),
    officeType,
    address: normalizeAddress(address),
    email: email?.trim() || undefined,
    phone: phone?.trim() || undefined,
    openingHours: normalizeOpeningHours(openingHours),
    nonWorkingDays: normalizeNonWorkingDays(nonWorkingDays),
    isPrimary: Boolean(isPrimary),
    isActive: isActive !== false,
    createdBy: userId || null,
    updatedBy: userId || null,
  });

  if (office.isPrimary) {
    await ensureSinglePrimary(tenantId, office._id, true);
  } else {
    const primaryCount = await TenantOffice.countDocuments({
      tenantId,
      isPrimary: true,
      isActive: true,
    });
    if (primaryCount === 0) {
      office.isPrimary = true;
      await office.save();
    }
  }

  return TenantOffice.findById(office._id);
};

const updateOffice = async (tenantId, officeId, payload, userId) => {
  const office = await getById(tenantId, officeId);
  if (!office) {
    const err = new Error("Office not found");
    err.statusCode = 404;
    throw err;
  }

  const fields = [
    "name",
    "officeType",
    "address",
    "email",
    "phone",
    "openingHours",
    "nonWorkingDays",
    "isPrimary",
    "isActive",
  ];

  for (const field of fields) {
    if (payload[field] === undefined) continue;

    if (field === "name") {
      if (!payload.name?.trim()) {
        const err = new Error("Office name is required");
        err.statusCode = 400;
        throw err;
      }
      office.name = payload.name.trim();
    } else if (field === "officeType") {
      if (!OFFICE_TYPES.includes(payload.officeType)) {
        const err = new Error("Invalid office type");
        err.statusCode = 400;
        throw err;
      }
      office.officeType = payload.officeType;
    } else if (field === "address") {
      office.address = normalizeAddress(payload.address);
    } else if (field === "openingHours") {
      office.openingHours = normalizeOpeningHours(payload.openingHours);
    } else if (field === "nonWorkingDays") {
      office.nonWorkingDays = normalizeNonWorkingDays(payload.nonWorkingDays);
    } else if (field === "email") {
      office.email = payload.email?.trim() || undefined;
    } else if (field === "phone") {
      office.phone = payload.phone?.trim() || undefined;
    } else if (field === "isPrimary") {
      office.isPrimary = Boolean(payload.isPrimary);
    } else if (field === "isActive") {
      office.isActive = Boolean(payload.isActive);
    }
  }

  office.updatedBy = userId || office.updatedBy;

  await office.save();

  if (office.isPrimary) {
    await ensureSinglePrimary(tenantId, office._id, true);
  }

  return TenantOffice.findById(office._id);
};

const setPrimaryOffice = async (tenantId, officeId, userId) => {
  const office = await getById(tenantId, officeId);
  if (!office) {
    const err = new Error("Office not found");
    err.statusCode = 404;
    throw err;
  }

  office.isPrimary = true;
  office.isActive = true;
  office.updatedBy = userId || office.updatedBy;
  await office.save();
  await ensureSinglePrimary(tenantId, office._id, true);
  return TenantOffice.findById(office._id);
};

const deactivateOffice = async (tenantId, officeId, userId) => {
  const office = await getById(tenantId, officeId);
  if (!office) {
    const err = new Error("Office not found");
    err.statusCode = 404;
    throw err;
  }

  const wasPrimary = office.isPrimary;
  office.isActive = false;
  office.isPrimary = false;
  office.updatedBy = userId || office.updatedBy;
  await office.save();

  if (wasPrimary) {
    const nextPrimary = await TenantOffice.findOne({
      tenantId,
      isActive: true,
      _id: { $ne: office._id },
    }).sort({ createdAt: 1 });
    if (nextPrimary) {
      await setPrimaryOffice(tenantId, nextPrimary._id, userId);
    }
  }

  return office;
};

module.exports = {
  OFFICE_TYPES,
  buildDefaultOpeningHours,
  listByTenant,
  getById,
  createOffice,
  updateOffice,
  setPrimaryOffice,
  deactivateOffice,
};
