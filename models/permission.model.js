const mongoose = require("mongoose");
const fieldWriteGuard = require("./plugins/fieldWriteGuard");
const { isPlatformNamespace } = require("../constants/permissionClassification");

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
  // PDP rollout P1/P5: which caller type a code is meant for (CRM staff, PORTAL members, or BOTH), or LEGACY =
  // deliberately left on the legacy per-resource category rule (never PDP-audience-scoped: MENU_*, CRM_*, nav and
  // admin codes...). Optional, no default: a row WITHOUT it is "not back-filled", which PDP_AUDIENCE_MODE=enforce
  // treats as missing data and DENIES (AUDIENCE_DATA_MISSING) - so LEGACY must be explicit, never inferred.
  // See services/policyEvaluationService.js and scripts/backfill-permission-audience.js.
  audience: {
    type: String,
    enum: ["CRM", "PORTAL", "BOTH", "LEGACY"],
    required: false,
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

// Phase B / Z3: the platform namespace is not part of the tenant permission catalogue. Platform codes live
// in code (constants/platformPermissions.js) and are granted only to PlatformPrincipals, so no code or
// resource in the "platform" namespace may be written here - which also means a role's ObjectId
// permission entry can never resolve to a platform code. See constants/permissionClassification.js.
PermissionSchema.plugin(fieldWriteGuard, {
  fields: ["code", "resource"],
  check(values, field) {
    if (values.some((v) => typeof v === "string" && isPlatformNamespace(v))) {
      const err = new Error(`Platform permissions are not part of the tenant permission catalogue (${field})`);
      err.status = 403;
      err.code = "PLATFORM_PERMISSION_RESERVED";
      throw err;
    }
  },
});

module.exports = mongoose.model("Permission", PermissionSchema);
