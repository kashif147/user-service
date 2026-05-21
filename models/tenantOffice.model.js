const mongoose = require("mongoose");
const { buildDefaultOpeningHours } = require("../constants/tenantOfficeDefaults");

const TenantOfficeSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    officeType: {
      type: String,
      enum: ["HEAD_OFFICE", "BRANCH", "REGIONAL_OFFICE"],
      default: "BRANCH",
    },
    address: {
      buildingOrHouse: { type: String, default: "" },
      streetOrRoad: { type: String, default: "" },
      areaOrTown: { type: String, default: "" },
      countyCityOrPostCode: { type: String, default: "" },
      eircode: { type: String, default: "" },
      country: { type: String, default: "Ireland" },
    },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    openingHours: [
      {
        day: {
          type: String,
          enum: [
            "MONDAY",
            "TUESDAY",
            "WEDNESDAY",
            "THURSDAY",
            "FRIDAY",
            "SATURDAY",
            "SUNDAY",
          ],
        },
        openTime: { type: String, default: "" },
        closeTime: { type: String, default: "" },
        isClosed: { type: Boolean, default: false },
      },
    ],
    nonWorkingDays: [
      {
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
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        notes: { type: String, trim: true, default: "" },
      },
    ],
    isPrimary: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

TenantOfficeSchema.index({ tenantId: 1, officeType: 1 });
TenantOfficeSchema.index({ tenantId: 1, isPrimary: 1 });

TenantOfficeSchema.pre("validate", function (next) {
  if (!this.openingHours?.length) {
    this.openingHours = buildDefaultOpeningHours();
  }
  next();
});

module.exports = mongoose.model("TenantOffice", TenantOfficeSchema);
