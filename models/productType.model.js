const mongoose = require("mongoose");

const productTypeSchema = new mongoose.Schema(
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
      unique: true,
      maxlength: 20,
      uppercase: true,
      trim: true,
    },
    description: {
      type: String,
      maxlength: 500,
      trim: true,
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

// Virtual for products count
productTypeSchema.virtual("productsCount", {
  ref: "Product",
  localField: "_id",
  foreignField: "productTypeId",
  count: true,
  match: { isDeleted: false },
});

// Indexes for performance
productTypeSchema.index({ code: 1, tenantId: 1 }, { unique: true });
productTypeSchema.index({ tenantId: 1, isActive: 1, isDeleted: 1 });
productTypeSchema.index({ name: 1, tenantId: 1 });

// Pre-save middleware to ensure code is uppercase
productTypeSchema.pre("save", function (next) {
  if (this.code) {
    this.code = this.code.toUpperCase();
  }
  next();
});

module.exports = mongoose.model("ProductType", productTypeSchema);
