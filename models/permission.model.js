const mongoose = require("mongoose");

const PermissionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
  },
  description: {
    type: String,
    required: true,
  },
  resource: {
    type: String,
    required: true,
    trim: true,
  },
  action: {
    type: String,
    required: true,
    trim: true,
  },
  category: {
    type: String,
    enum: [
      "GENERAL",
      "USER",
      "ROLE",
      "TENANT",
      "ACCOUNT",
      "PORTAL",
      "CRM",
      "ADMIN",
      "API",
      "AUDIT",
      "SUBSCRIPTION",
      "PROFILE",
      "FINANCIAL",
      "INVOICE",
      "RECEIPT",
      "COMMUNICATION",
    ],
    required: true,
  },
  level: {
    type: Number,
    required: true,
    min: 1,
    max: 100,
    default: 1,
  },
  isSystemPermission: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
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

// Indexes
PermissionSchema.index({ code: 1 }, { unique: true });
PermissionSchema.index({ resource: 1, action: 1 });
PermissionSchema.index({ category: 1 });
PermissionSchema.index({ level: 1 });
PermissionSchema.index({ isSystemPermission: 1 });

// Pre-save middleware to update audit fields
PermissionSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Permission", PermissionSchema);
