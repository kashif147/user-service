/**
 * DirectoryClaim (Stage 5b): which ProjectShell organisation a Microsoft Entra directory belongs
 * to, and whether that has been verified. This collection - not the inert legacy
 * connection.directoryOwnership - is authoritative for directory ownership.
 *
 *  - One ACTIVE (pending or verified) claim per connection, and per (organisation, directory);
 *    revoked claims are kept as audit history and any number may exist (Stage 5c-3).
 *  - One VERIFIED directory -> one organisation: a partial unique index on (connectionType,
 *    directoryId) over verified, non-exception claims, so concurrent writers cannot both win.
 *  - The DEV shared-directory exception (method "dev-exception") is outside that index and valid
 *    only while every DEV condition holds (helpers/directoryClaimPolicy.js); a verified exception
 *    claim and a verified normal claim for the same directory never coexist.
 *  - Ownership fields (connectionType, directoryId, tenantId, connectionId, method) are immutable.
 *  - Unknown fields are rejected (strict "throw"): no client ids, scopes, secrets, tokens, codes or
 *    appRef are ever stored here.
 *
 *  - Status: pending -> verified -> revoked. Revoked (Disconnect, Stage 5c-3) is terminal: a
 *    revoked claim is never changed again; a reconnect creates a NEW verified claim. Revoking
 *    touches only status, revokedAt and revokedBy - everything else stays as history.
 *
 * There is no tenant-admin API for claims: verified claims are created by the Microsoft admin
 * connection flow (Stage 5c) or a controlled platform/DEV operation, and revoked only by Disconnect.
 */
const mongoose = require("mongoose");
const {
  ENTRA,
  DIRECTORY_GUID,
  CONSUMER_DIRECTORY_ID,
  ADMIN_ROLE_TEMPLATE_IDS,
  devExceptionAllowed,
} = require("../helpers/directoryClaimPolicy");

const CLAIM_STATUSES = ["pending", "verified", "revoked"];
// Claims that still own their connection / (organisation, directory): the partial unique indexes
// below cover only these, so revoked history never blocks a new claim.
const ACTIVE_CLAIM_STATUSES = ["pending", "verified"];
const REVOKE_PATHS = ["status", "revokedAt", "revokedBy", "updatedAt"];
const CLAIM_METHODS = ["entra-admin-sign-in", "platform", "dev-exception"];
const SHARED_EXCEPTION_METHOD = "dev-exception";
const ADMIN_SIGN_IN_METHOD = "entra-admin-sign-in";


// Audit evidence of an entra-admin-sign-in verification, taken only from the verified Microsoft
// token. Never used for lookups, indexes or the claim gate - not a tenant-isolation identifier.
const verificationEvidenceSchema = new mongoose.Schema(
  {
    directoryUserId: { type: String, required: true, trim: true, lowercase: true, match: DIRECTORY_GUID },
    roleTemplateId: { type: String, required: true, trim: true, lowercase: true, enum: ADMIN_ROLE_TEMPLATE_IDS },
  },
  { _id: false, strict: "throw" }
);

const directoryClaimSchema = new mongoose.Schema(
  {
    connectionType: { type: String, enum: [ENTRA], required: true, immutable: true },
    directoryId: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      lowercase: true,
      match: DIRECTORY_GUID,
    },
    tenantId: { type: String, required: true, immutable: true, trim: true },
    connectionId: { type: String, required: true, immutable: true, trim: true },
    status: { type: String, enum: CLAIM_STATUSES, required: true, default: "pending" },
    method: { type: String, enum: CLAIM_METHODS, required: true, immutable: true },
    // Derived from method (set in pre-validate); part of the uniqueness index filter.
    sharedDirectoryException: { type: Boolean, required: true, default: false },
    claimedAt: { type: Date, required: true, default: Date.now },
    claimedBy: { type: String, required: true, trim: true },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: String, default: null, trim: true },
    verificationEvidence: { type: verificationEvidenceSchema, default: null },
    // Disconnect (Stage 5c-3): server time and initiating ProjectShell user ("user:<id>").
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null, trim: true },
  },
  { timestamps: true, strict: "throw", collection: "directoryclaims" }
);

// The status as loaded from the database (revoked is terminal; only verified may be revoked).
directoryClaimSchema.post("init", function rememberLoadedStatus() {
  this.$locals.loadedStatus = this.status;
});

directoryClaimSchema.pre("validate", function deriveAndCheck() {
  const loaded = this.isNew ? null : this.$locals.loadedStatus;
  if (loaded === "revoked" && this.isModified()) {
    this.invalidate("status", "A revoked claim is audit history and cannot be changed");
    return;
  }
  if (this.status === "revoked") {
    if (!this.revokedAt || !this.revokedBy) this.invalidate("revokedAt", "A revoked claim needs revokedAt and revokedBy");
    if (!this.isNew && loaded !== "revoked") {
      if (loaded !== "verified") this.invalidate("status", "Only a verified claim can be revoked");
      if (this.modifiedPaths().some((p) => !REVOKE_PATHS.includes(p))) {
        this.invalidate("status", "Revoking a claim changes only status, revokedAt and revokedBy");
      }
    }
  } else if (this.revokedAt || this.revokedBy) {
    this.invalidate("revokedAt", "Only a revoked claim carries revokedAt / revokedBy");
  }
  this.sharedDirectoryException = this.method === SHARED_EXCEPTION_METHOD;
  if (this.directoryId === CONSUMER_DIRECTORY_ID) {
    this.invalidate("directoryId", "The personal Microsoft account directory cannot be claimed");
  }
  if (this.status === "verified" && (!this.verifiedAt || !this.verifiedBy)) {
    this.invalidate("verifiedAt", "A verified claim needs verifiedAt and verifiedBy");
  }
  if (this.status === "pending" && (this.verifiedAt || this.verifiedBy)) {
    this.invalidate("status", "A pending claim cannot carry verification details");
  }
  if (this.sharedDirectoryException && !devExceptionAllowed(this.directoryId)) {
    this.invalidate("method", "The shared-directory exception is not allowed for this directory or environment");
  }
  // Evidence is written by the Connect flow (helpers/directoryClaimService.js) and belongs to admin
  // sign-in claims only; it is audit data, not a validity condition of the claim.
  const hasEvidence = this.verificationEvidence != null;
  if (this.method !== ADMIN_SIGN_IN_METHOD && hasEvidence) {
    this.invalidate("verificationEvidence", "Verification evidence belongs to admin sign-in claims only");
  }
});

// A verified normal claim and verified DEV-exception claims never share a directory. (Normal vs
// normal is enforced race-safely by the partial unique index below.)
directoryClaimSchema.pre("save", async function noMixedVerifiedClaims() {
  if (this.status !== "verified") return;
  const conflict = await this.constructor.exists({
    _id: { $ne: this._id },
    connectionType: this.connectionType,
    directoryId: this.directoryId,
    status: "verified",
    sharedDirectoryException: !this.sharedDirectoryException,
  });
  if (conflict) {
    const err = new Error("This directory is already verified for another organisation");
    err.code = "DIRECTORY_ALREADY_CLAIMED";
    throw err;
  }
});

directoryClaimSchema.index(
  { connectionType: 1, directoryId: 1 },
  {
    name: "uniq_verified_directory",
    unique: true,
    partialFilterExpression: { status: "verified", sharedDirectoryException: false },
  }
);
// Stage 5c-3: one ACTIVE claim per connection and per (organisation, directory); revoked history is
// outside both. New names: these replace uniq_claim_per_connection / uniq_claim_per_tenant_directory
// (dropped by scripts/migrate-directoryclaim-partial-indexes.js once these exist).
const ACTIVE_CLAIM_FILTER = { status: { $in: ACTIVE_CLAIM_STATUSES } };
directoryClaimSchema.index(
  { connectionType: 1, connectionId: 1 },
  { name: "uniq_active_claim_per_connection", unique: true, partialFilterExpression: ACTIVE_CLAIM_FILTER }
);
directoryClaimSchema.index(
  { connectionType: 1, directoryId: 1, tenantId: 1 },
  { name: "uniq_active_claim_per_tenant_directory", unique: true, partialFilterExpression: ACTIVE_CLAIM_FILTER }
);

const DirectoryClaim = mongoose.model("DirectoryClaim", directoryClaimSchema);
DirectoryClaim.CLAIM_STATUSES = CLAIM_STATUSES;
DirectoryClaim.ACTIVE_CLAIM_STATUSES = ACTIVE_CLAIM_STATUSES;
DirectoryClaim.CLAIM_METHODS = CLAIM_METHODS;
DirectoryClaim.ADMIN_ROLE_TEMPLATE_IDS = ADMIN_ROLE_TEMPLATE_IDS;
module.exports = DirectoryClaim;
