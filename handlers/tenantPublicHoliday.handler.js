const mongoose = require("mongoose");
const TenantPublicHoliday = require("../models/tenantPublicHoliday.model");

const HOLIDAY_CATEGORIES = [
  "BANK_HOLIDAY",
  "CHRISTMAS",
  "EASTER",
  "PUBLIC_HOLIDAY",
  "OTHER",
];

function parseDate(value, fieldName) {
  const d = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(d.getTime())) {
    const err = new Error(`${fieldName} is required`);
    err.statusCode = 400;
    throw err;
  }
  return d;
}

function normalizePayload(payload = {}) {
  const name = String(payload.name || "").trim();
  if (!name) {
    const err = new Error("Holiday name is required");
    err.statusCode = 400;
    throw err;
  }
  const startDate = parseDate(payload.startDate, "startDate");
  const endDate = payload.endDate
    ? parseDate(payload.endDate, "endDate")
    : startDate;
  if (endDate < startDate) {
    const err = new Error("endDate cannot be before startDate");
    err.statusCode = 400;
    throw err;
  }
  const category = HOLIDAY_CATEGORIES.includes(payload.category)
    ? payload.category
    : "PUBLIC_HOLIDAY";

  return {
    name,
    category,
    startDate,
    endDate,
    notes: String(payload.notes || "").trim(),
    isActive: payload.isActive !== false,
  };
}

async function listByTenant(
  tenantId,
  { includeInactive = false, from = null, to = null } = {}
) {
  const query = { tenantId };
  if (!includeInactive) query.isActive = true;
  if (from || to) {
    query.startDate = {};
    query.endDate = {};
    if (to) query.startDate.$lte = new Date(to);
    if (from) query.endDate.$gte = new Date(from);
    if (Object.keys(query.startDate).length === 0) delete query.startDate;
    if (Object.keys(query.endDate).length === 0) delete query.endDate;
  }
  return TenantPublicHoliday.find(query).sort({ startDate: 1, name: 1 });
}

async function getById(tenantId, holidayId) {
  if (!mongoose.Types.ObjectId.isValid(holidayId)) return null;
  return TenantPublicHoliday.findOne({ _id: holidayId, tenantId });
}

async function createHoliday(tenantId, payload, userId) {
  return TenantPublicHoliday.create({
    tenantId,
    ...normalizePayload(payload),
    createdBy: userId || null,
    updatedBy: userId || null,
  });
}

async function updateHoliday(tenantId, holidayId, payload, userId) {
  const holiday = await getById(tenantId, holidayId);
  if (!holiday) {
    const err = new Error("Public holiday not found");
    err.statusCode = 404;
    throw err;
  }
  const normalized = normalizePayload({ ...holiday.toObject(), ...payload });
  Object.assign(holiday, normalized);
  holiday.updatedBy = userId || holiday.updatedBy;
  await holiday.save();
  return holiday;
}

async function deactivateHoliday(tenantId, holidayId, userId) {
  const holiday = await getById(tenantId, holidayId);
  if (!holiday) {
    const err = new Error("Public holiday not found");
    err.statusCode = 404;
    throw err;
  }
  holiday.isActive = false;
  holiday.updatedBy = userId || holiday.updatedBy;
  await holiday.save();
  return holiday;
}

module.exports = {
  HOLIDAY_CATEGORIES,
  listByTenant,
  getById,
  createHoliday,
  updateHoliday,
  deactivateHoliday,
};
