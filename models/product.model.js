const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      maxlength: 100,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      maxlength: 20,
      uppercase: true,
      trim: true,
    },
    description: {
      type: String,
      maxlength: 500,
      trim: true,
    },
    productTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductType",
      required: true,
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    tenantId: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for current pricing
productSchema.virtual("currentPricing", {
  ref: "Pricing",
  localField: "_id",
  foreignField: "productId",
  justOne: true,
  match: {
    isActive: true,
    isDeleted: false,
    effectiveFrom: { $lte: new Date() },
    $or: [{ effectiveTo: { $gte: new Date() } }, { effectiveTo: null }],
  },
  options: { sort: { effectiveFrom: -1 } },
});

// Virtual for all pricing history
productSchema.virtual("pricingHistory", {
  ref: "Pricing",
  localField: "_id",
  foreignField: "productId",
  match: { isDeleted: false },
  options: { sort: { effectiveFrom: -1 } },
});

// Indexes for performance
productSchema.index({ code: 1, tenantId: 1 }, { unique: true });
productSchema.index({ productTypeId: 1, isActive: 1, isDeleted: 1 });
productSchema.index({ tenantId: 1, isActive: 1, isDeleted: 1 });
productSchema.index({ name: 1, tenantId: 1 });

// Pre-save middleware to ensure code is uppercase
productSchema.pre("save", function (next) {
  if (this.code) {
    this.code = this.code.toUpperCase();
  }
  next();
});

module.exports = mongoose.model("Product", productSchema);
