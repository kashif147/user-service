const Tenant = require("../models/tenant.model");
const TenantOffice = require("../models/tenantOffice.model");
const TenantPublicHoliday = require("../models/tenantPublicHoliday.model");
const Role = require("../models/role.model");
const User = require("../models/user.model");
const { normalizeLifecycleBatches } = require("../constants/tenantUpdateDefaults");

function requireInternal(req, res, next) {
  if (
    req.headers["x-internal-request"] === "true" ||
    req.headers["x-internal-request"] === "1"
  ) {
    return next();
  }
  return res.status(401).json({
    status: "fail",
    message: "Internal request required",
  });
}

function mapTenantLifecycle(tenant) {
  const obj = tenant?.toObject?.() ?? tenant;
  return {
    tenantId: String(obj._id),
    name: obj.name,
    code: obj.code,
    regionalSettings: obj.regionalSettings || {},
    lifecycleBatches: normalizeLifecycleBatches(obj.settings?.lifecycleBatches),
  };
}

async function getLifecycleConfigForTenant(tenantId) {
  const [tenant, primaryOffice, publicHolidays] = await Promise.all([
    Tenant.findOne({ _id: tenantId, isActive: true }).lean(),
    TenantOffice.findOne({ tenantId, isPrimary: true, isActive: true }).lean(),
    TenantPublicHoliday.find({ tenantId, isActive: true })
      .sort({ startDate: 1 })
      .lean(),
  ]);
  if (!tenant) return null;
  return {
    ...mapTenantLifecycle(tenant),
    primaryOffice: primaryOffice || null,
    publicHolidays,
  };
}

async function getAllLifecycleConfigs(req, res) {
  try {
    const tenants = await Tenant.find({ isActive: true, status: "ACTIVE" })
      .select("name code regionalSettings settings.lifecycleBatches")
      .lean();
    const configs = [];
    for (const tenant of tenants) {
      const config = await getLifecycleConfigForTenant(tenant._id);
      if (config) configs.push(config);
    }
    return res.status(200).json({ status: "success", data: configs });
  } catch (error) {
    console.error("[tenantLifecycle] getAllLifecycleConfigs", error);
    return res.status(500).json({
      status: "fail",
      message: "Failed to load lifecycle configs",
    });
  }
}

async function getLifecycleConfig(req, res) {
  try {
    const config = await getLifecycleConfigForTenant(req.params.tenantId);
    if (!config) {
      return res.status(404).json({
        status: "fail",
        message: "Tenant lifecycle config not found",
      });
    }
    return res.status(200).json({ status: "success", data: config });
  } catch (error) {
    console.error("[tenantLifecycle] getLifecycleConfig", error);
    return res.status(500).json({
      status: "fail",
      message: "Failed to load lifecycle config",
    });
  }
}

async function getNotificationRecipients(req, res) {
  try {
    const tenantId = req.params.tenantId;
    const roleCodes = String(req.query.roleCodes || "MO")
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean);

    const roles = await Role.find({
      tenantId,
      code: { $in: roleCodes },
      category: "CRM",
      isActive: true,
    })
      .select("_id code name")
      .lean();
    const roleIds = roles.map((role) => role._id);
    const users = roleIds.length
      ? await User.find({
          tenantId,
          userType: "CRM",
          isActive: true,
          roles: { $in: roleIds },
        })
          .select("_id userEmail userFullName roles")
          .lean()
      : [];

    return res.status(200).json({
      status: "success",
      data: {
        roleCodes,
        roles,
        users,
      },
    });
  } catch (error) {
    console.error("[tenantLifecycle] getNotificationRecipients", error);
    return res.status(500).json({
      status: "fail",
      message: "Failed to load notification recipients",
    });
  }
}

module.exports = {
  requireInternal,
  getAllLifecycleConfigs,
  getLifecycleConfig,
  getNotificationRecipients,
};
