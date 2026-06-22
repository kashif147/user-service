const mongoose = require("mongoose");

const TenantPublicHolidaySchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: [
        "BANK_HOLIDAY",
        "CHRISTMAS",
        "EASTER",
        "PUBLIC_HOLIDAY",
        "OTHER",
      ],
      default: "PUBLIC_HOLIDAY",
    },
    startDate: { type: Date, required: true, index: true },
    endDate: { type: Date, required: true, index: true },
    notes: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

TenantPublicHolidaySchema.index({ tenantId: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model(
  "TenantPublicHoliday",
  TenantPublicHolidaySchema
);
