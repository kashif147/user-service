const mongoose = require("mongoose");
const fieldWriteGuard = require("./plugins/fieldWriteGuard");
const { isPlatformNamespace, canonicalPermission } = require("../constants/permissionClassification");
const { RolePrivilegeError } = require("../errors/RolePrivilegeError");

const RoleSchema = new mongoose.Schema({
  // Tenant isolation - mandatory field
  tenantId: {
    type: String,
    required: true,
    index: true,
  },

  name: {
    type: String,
    required: true,
    trim: true,
  },
  code: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    enum: ["PORTAL", "CRM", "SYSTEM"],
    required: true,
  },
  level: {
    type: Number,
    default: 1,
    min: 1,
    max: 100,
    index: true,
  },
  permissions: [
    {
      type: String,
    },
  ],
  isActive: {
    type: Boolean,
    default: true,
  },
  isSystemRole: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },

  // Audit fields
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
});

// Compound indexes for tenant isolation
RoleSchema.index({ tenantId: 1, code: 1 }, { unique: true }); // Unique role code per tenant
RoleSchema.index({ tenantId: 1, name: 1 }, { unique: true }); // Unique role name per tenant

RoleSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Phase B / Z3: a tenant role can never hold a platform-namespace permission (today's catalogue or any
// future platform:* code), on any Mongoose write path - not only through handlers/role.handler.js.
// ObjectId entries reference the Permission catalogue, which can never contain a platform code
// (models/permission.model.js). See constants/permissionClassification.js.
RoleSchema.plugin(fieldWriteGuard, {
  fields: ["permissions"],
  check(values) {
    const platform = values.filter((v) => typeof v === "string" && isPlatformNamespace(v));
    if (platform.length) {
      throw new RolePrivilegeError(
        `Platform permissions cannot be granted to a tenant role: ${[...new Set(platform.map(canonicalPermission))].join(", ")}`
      );
    }
  },
});

module.exports = mongoose.model("Role", RoleSchema);
