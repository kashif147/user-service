const mongoose = require("mongoose");

const pricingSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    currency: {
      type: String,
      required: true,
      maxlength: 3,
      uppercase: true,
      trim: true,
      default: "EUR",
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: function (v) {
          return v >= 0;
        },
        message: "Price must be a positive number",
      },
    },
    effectiveFrom: {
      type: Date,
      required: true,
      default: Date.now,
    },
    effectiveTo: {
      type: Date,
      default: null,
      validate: {
        validator: function (v) {
          if (v && this.effectiveFrom) {
            return v > this.effectiveFrom;
          }
          return true;
        },
        message: "Effective To date must be after Effective From date",
      },
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

// Virtual for product details
pricingSchema.virtual("product", {
  ref: "Product",
  localField: "productId",
  foreignField: "_id",
  justOne: true,
});

// Indexes for performance
pricingSchema.index({ productId: 1, isActive: 1, isDeleted: 1 });
pricingSchema.index({ effectiveFrom: 1, effectiveTo: 1 });
pricingSchema.index({ tenantId: 1, isActive: 1, isDeleted: 1 });
pricingSchema.index({
  productId: 1,
  effectiveFrom: 1,
  effectiveTo: 1,
  isActive: 1,
  isDeleted: 1,
});

// Pre-save middleware to ensure currency is uppercase
pricingSchema.pre("save", function (next) {
  if (this.currency) {
    this.currency = this.currency.toUpperCase();
  }
  next();
});

// Static method to get current pricing for a product
pricingSchema.statics.getCurrentPricing = function (
  productId,
  date = new Date()
) {
  return this.findOne({
    productId,
    isActive: true,
    isDeleted: false,
    effectiveFrom: { $lte: date },
    $or: [{ effectiveTo: { $gte: date } }, { effectiveTo: null }],
  }).sort({ effectiveFrom: -1 });
};

// Static method to get pricing history for a product
pricingSchema.statics.getPricingHistory = function (productId) {
  return this.find({
    productId,
    isDeleted: false,
  }).sort({ effectiveFrom: -1 });
};

module.exports = mongoose.model("Pricing", pricingSchema);
