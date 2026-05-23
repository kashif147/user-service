const mongoose = require("mongoose");

const TenantDepartmentSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    displayOrder: { type: Number, default: 0 },
    isPublic: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

TenantDepartmentSchema.index({ tenantId: 1, code: 1 }, { unique: true });
TenantDepartmentSchema.index({ tenantId: 1, isActive: 1 });

module.exports = mongoose.model("TenantDepartment", TenantDepartmentSchema);
