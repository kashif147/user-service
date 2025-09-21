const mongoose = require("mongoose");

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
  userType: {
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

module.exports = mongoose.model("Role", RoleSchema);
