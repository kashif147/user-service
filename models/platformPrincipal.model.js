/**
 * PlatformPrincipal (Phase B / Z1): an explicitly allow-listed Microsoft Entra identity that holds
 * ProjectShell PLATFORM authority. Being in a directory, holding a tenant role (SU, ASU, "*"), an
 * email, a display name or an organisation code never makes anyone a platform principal - only an
 * active record here does.
 *
 *  - Identity = the VERIFIED ID token's issuer + oid (the immutable Entra object id). Unique on
 *    (issuer, oid). Never keyed by email, name, tenant, role or organisation code. `tid` is the
 *    directory id the issuer names (kept for querying; must agree with the issuer).
 *  - Identity fields are immutable: a different person is a new record, never an edit.
 *  - status: active | disabled. Disabled records are kept (history); there is no delete path.
 *  - permissions: only codes from constants/platformPermissions.js.
 *  - revision: incremented on every change. The platform claim carries it, so (from Z2) a token
 *    minted before a disable / permission change no longer matches the record.
 *  - changes: append-only history of who did what (ops script in Z1; platform API from Z2).
 *  - Unknown fields are rejected (strict "throw"): no tokens, secrets, emails or names are stored.
 *
 * Written only by scripts/platform-principal.js (owner-approved, reviewed). Read by the CRM sign-in
 * claim lookup (Z1) and by the platform authorization evaluator (Z2,
 * services/platformAuthorizationService.js); no HTTP route writes it.
 */
const mongoose = require("mongoose");
const { PLATFORM_PERMISSIONS, isPlatformPermission } = require("../constants/platformPermissions");
const fieldWriteGuard = require("./plugins/fieldWriteGuard");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTRA_V2_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/;
const STATUSES = ["active", "disabled"];
const IDENTITY_FIELDS = ["issuer", "oid", "tid"];

const changeSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: String, required: true, maxlength: 200 },
    action: { type: String, required: true, enum: ["create", "disable", "enable", "set-permissions"] },
    approval: { type: String, maxlength: 200, default: null },
    revision: { type: Number, required: true },
    status: { type: String, enum: STATUSES, required: true },
    permissions: { type: [String], default: [] },
  },
  { _id: false, strict: "throw" }
);

const platformPrincipalSchema = new mongoose.Schema(
  {
    issuer: { type: String, required: true, match: ENTRA_V2_ISSUER, immutable: true },
    oid: { type: String, required: true, match: GUID, immutable: true },
    tid: { type: String, required: true, match: GUID, immutable: true },
    status: { type: String, required: true, enum: STATUSES, default: "active" },
    permissions: {
      type: [{ type: String, enum: PLATFORM_PERMISSIONS }],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && new Set(v).size === v.length,
        message: "duplicate platform permission",
      },
    },
    revision: { type: Number, required: true, default: 1, min: 1 },
    // Free-text, non-identifying label for operators (e.g. "DEV Z1 throwaway"). Never an email/name.
    label: { type: String, maxlength: 100, default: null },
    createdBy: { type: String, required: true, maxlength: 200, immutable: true },
    updatedBy: { type: String, required: true, maxlength: 200 },
    changes: { type: [changeSchema], default: [] },
  },
  { timestamps: true, strict: "throw", collection: "platformprincipals" }
);

platformPrincipalSchema.index({ issuer: 1, oid: 1 }, { unique: true, name: "uniq_platform_identity" });

platformPrincipalSchema.pre("validate", function checkTid(next) {
  const m = ENTRA_V2_ISSUER.exec(this.issuer || "");
  if (m && m[1] !== this.tid) return next(new Error("PlatformPrincipal tid must be the issuer's directory"));
  return next();
});

// Identity fields can never change through a query update either ($set / $unset / $rename / replace).
function refuseIdentityUpdate(next) {
  const u = this.getUpdate() || {};
  const touched = (obj) => obj && IDENTITY_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(obj, f));
  if (touched(u) || touched(u.$set) || touched(u.$unset) || touched(u.$rename) || touched(u.$setOnInsert)) {
    return next(new Error("PlatformPrincipal identity (issuer, oid, tid) is immutable"));
  }
  return next();
}
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"]) {
  platformPrincipalSchema.pre(op, refuseIdentityUpdate);
}

// Phase B / Z3: permissions hold exact catalogue codes only - never "*", "platform:*", a prefix wildcard or a
// tenant code - on every write path, including query updates without runValidators.
platformPrincipalSchema.plugin(fieldWriteGuard, {
  fields: ["permissions"],
  check(values) {
    const bad = values.filter((v) => !isPlatformPermission(v));
    if (bad.length) throw new Error("PlatformPrincipal permissions must be exact platform catalogue codes");
  },
});

const PlatformPrincipal = mongoose.model("PlatformPrincipal", platformPrincipalSchema);

PlatformPrincipal.ENTRA_V2_ISSUER = ENTRA_V2_ISSUER;
PlatformPrincipal.GUID = GUID;
PlatformPrincipal.STATUSES = STATUSES;

module.exports = PlatformPrincipal;
