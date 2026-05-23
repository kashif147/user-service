const mongoose = require("mongoose");

const TenantContactSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TenantDepartment",
      required: true,
    },
    fullName: { type: String, required: true, trim: true },
    roleTitle: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    mobile: { type: String, trim: true },
    isPrimaryContact: { type: Boolean, default: false },
    displayOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

TenantContactSchema.index({ tenantId: 1, departmentId: 1 });
TenantContactSchema.index({ tenantId: 1, isPrimaryContact: 1 });
TenantContactSchema.index({ tenantId: 1, departmentId: 1, isPrimaryContact: 1 });

module.exports = mongoose.model("TenantContact", TenantContactSchema);
