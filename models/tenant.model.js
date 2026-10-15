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
  organisationProfile: {
    legalName: { type: String, trim: true },
    tradingName: { type: String, trim: true },
    registrationNumber: { type: String, trim: true },
    charityNumber: { type: String, trim: true },
    vatNumber: { type: String, trim: true },
    website: { type: String, trim: true, lowercase: true },
    email: { type: String, trim: true, lowercase: true },
    contactNumber: { type: String, trim: true },
    bankName: { type: String, trim: true },
    bankAddress: {
      buildingOrHouse: { type: String, default: "" },
      streetOrRoad: { type: String, default: "" },
      areaOrTown: { type: String, default: "" },
      countyCityOrPostCode: { type: String, default: "" },
      eircode: { type: String, default: "" },
      country: { type: String, default: "Ireland" },
    },
    iban: { type: String, trim: true },
    bic: { type: String, trim: true },
    sepaOriginatorIdentificationNumber: { type: String, trim: true },
  },
  branding: {
    logoUrl: { type: String },
    logoDarkUrl: { type: String },
    faviconUrl: { type: String },
    primaryColor: { type: String, default: "#215e97" },
    secondaryColor: { type: String, default: "#475569" },
    accentColor: { type: String, default: "#0d9488" },
    secondaryBackgroundColor: { type: String, default: "#eef2f6" },
    portalTitle: { type: String, default: "Project Shell" },
    emailFooterText: { type: String },
    letterHeaderUrl: { type: String },
    letterFooterUrl: { type: String },
  },
  regionalSettings: {
    timezone: { type: String, default: "Europe/Dublin" },
    locale: { type: String, default: "en-IE" },
    currency: { type: String, default: "EUR" },
    dateFormat: { type: String, default: "DD/MM/YYYY" },
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
    lifecycleBatches: {
      reminder: {
        generateMode: {
          type: String,
          enum: ["manual", "automatic"],
          default: "manual",
        },
        executeMode: {
          type: String,
          enum: ["manual", "automatic"],
          default: "manual",
        },
      },
      cancellation: {
        generateMode: {
          type: String,
          enum: ["manual", "automatic"],
          default: "manual",
        },
        executeMode: {
          type: String,
          enum: ["manual", "automatic"],
          default: "manual",
        },
      },
      schedule: {
        dayMode: {
          type: String,
          enum: ["FIRST_DAY", "FIRST_WORKING_DAY"],
          default: "FIRST_WORKING_DAY",
        },
      },
      notificationRecipientRoleCodes: {
        type: [String],
        default: ["MO"],
      },
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
      // Legacy (deprecated): never read for sign-in - the issuer is derived from directoryId
      // (helpers/connectionAuthConfig.js). Optional; validated only when a value is supplied.
      issuerUrl: {
        type: String,
        validate: {
          validator: function (v) {
            return (
              v == null ||
              v === "" ||
              /^https:\/\/login\.microsoftonline\.com\/[^\/]+\/v2\.0$/.test(v)
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
      // Legacy (deprecated for sign-in): the audience is the registered application's client id.
      // Still matched by the Azure B2C sign-up connector (helpers/b2cConnectorTenant.js). Optional.
      audience: {
        type: String,
        trim: true,
      },
      // Registered application (helpers/authAppRegistry.js) this connection signs in through.
      // Optional: unset = the provider's compatibility default (crm-entra / portal-b2c).
      appRef: {
        type: String,
        trim: true,
        default: undefined,
      },
      // Who owns the directory. Entra: customer | shared-nonprod; Azure B2C: customer |
      // projectshell-shared (validated per provider, helpers/connectionDefaultRole.js).
      directoryOwnership: {
        type: String,
        enum: ["customer", "shared-nonprod", "projectshell-shared"],
        default: undefined,
      },
      // Server-managed (never written from a request body): set by the future connect / test flows.
      connectedAt: { type: Date, default: undefined },
      connectedBy: { type: String, default: undefined },
      lastTestedAt: { type: Date, default: undefined },
      lastTestResult: {
        type: new mongoose.Schema({ ok: Boolean, code: String }, { _id: false }),
        default: undefined,
      },
      isActive: {
        type: Boolean,
        default: true,
      },
      // true: users signing in through this connection for the first time are created
      // just-in-time (and the B2C sign-up connector may target this tenant). false or unset:
      // pre-authorised users only. Deliberately no default, so an unset value stays visible and
      // is treated as false (helpers/connectionDefaultRole.js). Existing users sign in either way.
      autoProvisionUsers: {
        type: Boolean,
      },
      // Role given to a user created just-in-time through this connection. Required when
      // autoProvisionUsers is true; validated on save and again at sign-in
      // (helpers/connectionDefaultRole.js).
      defaultRoleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Role",
        default: undefined,
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
