const mongoose = require("mongoose");
const { tenantOwnershipPlugin } = require("./plugins/tenantOwnership.plugin");

// Phase B / Z7: a User belongs to exactly ONE internal ProjectShell tenant (a Tenant _id, 24 hex), set at
// creation from trusted server-side context and never changed. The same real person in two tenants is two
// tenant-local User rows (identity uniqueness below is tenant-qualified), never one row moved between them.
const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;

const UserSchema = new mongoose.Schema({
  // Tenant isolation - mandatory field
  tenantId: {
    type: String,
    required: true,
    index: true,
    // Phase B / Z7: creation needs a real internal tenant id - never null / "default" / "unknown" / an org
    // code / an Entra tid. Immutability (every write path) is the A15 plugin at the end of this file.
    validate: {
      validator: (v) => typeof v === "string" && INTERNAL_TENANT_ID.test(v),
      message: "tenantId must be an internal ProjectShell tenant id",
    },
  },

  userEmail: { type: String, default: null }, // `emails[0]` ADB2C
  userFirstName: { type: String, default: null }, // `given_name` ADB2C
  userLastName: { type: String, default: null }, // `family_name` ADB2C
  userFullName: { type: String, default: null }, //given_name + family_name ADB2C
  userMobilePhone: { type: String, default: null }, // `extension_mobilePhone` ADB2C
  userMemberNumber: { type: String, default: null }, // `extension_MemberNo` ADB2C
  userMicrosoftId: { type: String, default: null }, // `oid` ADB2C
  userAuthProvider: { type: String, default: "microsoft" }, // fixed value for tracking auth source ADB2C
  userSubject: { type: String, default: null }, // `sub` ADB2C
  userAudience: { type: String, default: null }, // `aud` ADB2C
  userIssuer: { type: String, default: null }, // `iss` ADB2C
  userIssuedAt: { type: Number, default: null }, // `iat` ADB2C
  userAuthTime: { type: Number, default: null }, // `auth_time` ADB2C
  userTokenVersion: { type: String, default: null }, // `ver` ADB2C
  userPolicy: { type: String, default: null }, // `tfp` ADB2C
  userType: { type: String, enum: ["PORTAL", "CRM"], default: "PORTAL" }, // PORTAL for B2C, CRM for Azure AD
  userLastLogin: { type: Date, default: Date.now }, // current timestamp
  userLastLogout: { type: Date, default: null }, // logout timestamp
  password: { type: String },

  // RBAC fields
  roles: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
    },
  ],
  isActive: {
    type: Boolean,
    default: true,
  },

  tokens: {
    id_token: { type: String, default: null }, // full ID token from Microsoft
    refresh_token: { type: String, default: null }, // refresh token
    id_token_expires_in: { type: Number, default: null }, // token expiry time (optional)
    // Remaining lifetime in seconds from Microsoft (not Unix time)
    refresh_token_expires_in: { type: Number, default: null },
    // Absolute expiry of refresh token (ms since epoch); used for /auth/refresh checks
    refresh_token_expires_at: { type: Number, default: null },
  },

  // Audit fields
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Compound indexes for tenant isolation
UserSchema.index({ tenantId: 1, userEmail: 1 }, { unique: true }); // Unique email per tenant
// Phase A / A8: identity uniqueness applies only to POPULATED identifiers. { $gt: "" } matches non-empty
// strings only (BSON type bracketing excludes null / missing / ""), so users without an oid or sub
// (e.g. created before first sign-in) no longer collide, while every real id stays unique per tenant.
// Built by scripts/migrate-user-identity-partial-indexes.js (which drops the old non-partial pair).
UserSchema.index(
  { tenantId: 1, userMicrosoftId: 1 },
  { unique: true, name: "tenantId_1_userMicrosoftId_1_partial", partialFilterExpression: { userMicrosoftId: { $gt: "" } } }
); // Unique Microsoft ID per tenant (when present)
UserSchema.index(
  { tenantId: 1, userSubject: 1 },
  { unique: true, name: "tenantId_1_userSubject_1_partial", partialFilterExpression: { userSubject: { $gt: "" } } }
); // Unique subject per tenant (when present)
UserSchema.index({ tenantId: 1, roles: 1, isActive: 1 }); // Fast role-assigned user lookups

// Index for Azure B2C validation endpoint (cross-tenant duplicate check)
UserSchema.index({ userEmail: 1, isActive: 1 }); // Fast lookup for validation endpoint

// Index for refresh token lookups
UserSchema.index({ "tokens.refresh_token": 1 }, { sparse: true }); // Sparse index for refresh token queries

// Pre-save middleware to update audit fields
UserSchema.pre("save", function (next) {
  if (this.userFirstName || this.userLastName) {
    this.userFullName = `${this.userFirstName || ""} ${
      this.userLastName || ""
    }`.trim();
  }
  this.updatedAt = Date.now();
  next();
});

UserSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate() || {};
  const set = update.$set || update;

  const firstName = set.userFirstName;
  const lastName = set.userLastName;

  if (firstName !== undefined || lastName !== undefined) {
    set.userFullName = `${firstName || ""} ${lastName || ""}`.trim() || null;
  }

  set.updatedAt = Date.now();

  if (update.$set) {
    update.$set = set;
  } else {
    this.setUpdate(set);
  }

  next();
});

// Phase B / Z7: tenant ownership immutability (Phase A / A15 guard, as ProductType): save, updateOne,
// updateMany, findOneAndUpdate / findByIdAndUpdate, replaceOne, findOneAndReplace, bulkWrite and pipeline
// updates can never change, unset, null or placeholder User.tenantId -> 409 TENANT_IMMUTABLE (the write is
// rejected, not silently restored). No runtime bypass.
UserSchema.plugin(tenantOwnershipPlugin, { modelName: "User" });
// Assigning a DIFFERENT tenantId to an existing (loaded) User marks the document; its next save() is then
// REJECTED with 409 TENANT_IMMUTABLE (mongoose's immutable setter alone would silently keep the old value and
// save the rest). Same value = no change. Phase B / Z8: "different" includes filling a missing / null / empty
// tenantId on an existing User (the retired legacy-repair shape `if (!user.tenantId) user.tenantId = X`) -
// ownership is set once, at creation, never afterwards. Mongoose runs setters last-added first, so this sees
// the requested value; query casting has no Document `this` and is covered by the plugin's query / bulk guards.
const { AppError } = require("../errors/AppError");
const tenantViolation = (op) => {
  console.warn(JSON.stringify({ level: "warn", message: "TenantOwnershipViolation", eventType: "tenant.ownership_violation", model: "User", op, reason: "tenant_change" }));
  return new AppError("Tenant ownership cannot be changed", 409, "TENANT_IMMUTABLE", { model: "User", op, reason: "tenant_change" });
};
UserSchema.path("tenantId").set(function flagTenantReassignment(value) {
  if (this instanceof mongoose.Document && !this.isNew) {
    const current = this.get("tenantId");
    if (String(value ?? "") !== String(current ?? "")) {
      this.$locals.tenantReassignmentAttempted = true;
      tenantViolation("assign");
    }
  }
  return value;
});
function rejectTenantReassignment() {
  if (this.$locals && this.$locals.tenantReassignmentAttempted) throw tenantViolation("save");
}
UserSchema.pre("validate", rejectTenantReassignment);
UserSchema.pre("save", rejectTenantReassignment); // also when saved with validateBeforeSave: false

module.exports = mongoose.model("User", UserSchema);
