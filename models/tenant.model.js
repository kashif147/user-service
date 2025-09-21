const mongoose = require("mongoose");

const TenantSchema = new mongoose.Schema({
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
  domain: {
    type: String,
    required: true,
    lowercase: true,
  },
  contactEmail: {
    type: String,
    required: true,
    lowercase: true,
  },
  contactPhone: {
    type: String,
    required: false,
  },
  address: {
    street: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    country: { type: String, default: "US" },
  },
  settings: {
    maxUsers: { type: Number, default: 100 },
    allowSelfRegistration: { type: Boolean, default: true },
    sessionTimeout: { type: Number, default: 24 }, // hours
    passwordPolicy: {
      minLength: { type: Number, default: 8 },
      requireUppercase: { type: Boolean, default: true },
      requireLowercase: { type: Boolean, default: true },
      requireNumbers: { type: Boolean, default: true },
      requireSpecialChars: { type: Boolean, default: true },
    },
  },
  status: {
    type: String,
    enum: ["ACTIVE", "INACTIVE", "SUSPENDED", "PENDING"],
    default: "PENDING",
  },
  subscription: {
    plan: {
      type: String,
      enum: ["FREE", "BASIC", "PREMIUM", "ENTERPRISE"],
      default: "FREE",
    },
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date },
    autoRenew: { type: Boolean, default: true },
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
  // Authentication connections
  authenticationConnections: [
    {
      connectionType: {
        type: String,
        enum: ["Entra ID (Azure AD)", "Azure B2C"],
        required: true,
      },
      issuerUrl: {
        type: String,
        required: true,
        validate: {
          validator: function (v) {
            return /^https:\/\/login\.microsoftonline\.com\/[^\/]+\/v2\.0$/.test(
              v
            );
          },
          message: "Issuer URL must be a valid Microsoft login URL",
        },
      },
      directoryId: {
        type: String,
        required: true,
        trim: true,
      },
      audience: {
        type: String,
        required: true,
        trim: true,
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
    },
  ],
  // Audit fields
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
});

// Indexes
TenantSchema.index({ code: 1 }, { unique: true });
TenantSchema.index({ domain: 1 }, { unique: true });
TenantSchema.index({ status: 1 });
TenantSchema.index({ "subscription.plan": 1 });
TenantSchema.index({ "authenticationConnections.directoryId": 1 });
TenantSchema.index({ "authenticationConnections.audience": 1 });

// Pre-save middleware to update audit fields
TenantSchema.pre("save", function (next) {
  this.updatedAt = Date.now();

  // Update authentication connection timestamps if they were modified
  if (this.isModified("authenticationConnections")) {
    this.authenticationConnections.forEach((connection) => {
      if (connection.isModified()) {
        connection.updatedAt = Date.now();
      }
    });
  }

  next();
});

module.exports = mongoose.model("Tenant", TenantSchema);
