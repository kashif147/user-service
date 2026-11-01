/**
 * PlatformTemplate (Phase B / P1): a PUBLISHED, immutable provisioning template version - which provisioning
 * components (service-owned versioned tenant defaults, constants/provisioningComponents.js) at which pinned
 * manifest versions / digests a new tenant is expected to receive.
 *
 *  - Platform-owned metadata: there is NO tenantId - a template belongs to no tenant and holds no tenant data,
 *    no copied tenantless rows, no lookups and nothing read back from a tenant.
 *  - Published from reviewed code only (constants/platformTemplates.js) by scripts/platform-template.js; no
 *    HTTP route writes it. contentHash = templateContentHash(definition), checked on every save.
 *  - Immutable once published: key, version, description, components and contentHash never change, on any
 *    write path. The only change is published -> retired (retire never deletes). There is no delete path.
 *  - Unknown fields are rejected (strict "throw").
 */
const mongoose = require("mongoose");
const { TEMPLATE_KEY, templateContentHash, validateDefinition } = require("../constants/platformTemplates");

const STATUSES = ["published", "retired"];
const IMMUTABLE_FIELDS = ["key", "version", "description", "components", "contentHash", "publishedAt", "publishedBy"];
const MUTABLE_FIELDS = new Set(["status", "retiredAt", "retiredBy", "updatedAt"]);
const SHA256 = /^[0-9a-f]{64}$/;

const componentSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true, min: 1 },
    component: { type: String, required: true, maxlength: 100 },
    service: { type: String, required: true, maxlength: 64 },
    version: { type: Number, required: true, min: 1 },
    manifestSha256: { type: String, required: true, match: SHA256 },
    required: { type: Boolean, required: true },
  },
  { _id: false, strict: "throw" }
);

const platformTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, match: TEMPLATE_KEY, immutable: true },
    version: { type: Number, required: true, min: 1, immutable: true },
    description: { type: String, maxlength: 300, default: "", immutable: true },
    components: { type: [componentSchema], required: true, immutable: true },
    contentHash: { type: String, required: true, match: SHA256, immutable: true },
    status: { type: String, required: true, enum: STATUSES, default: "published" },
    publishedAt: { type: Date, required: true, immutable: true },
    // operator-supplied label of the reviewed publish (script --by), never an email or a token
    publishedBy: { type: String, required: true, maxlength: 120, immutable: true },
    retiredAt: { type: Date, default: null },
    retiredBy: { type: String, maxlength: 120, default: null },
  },
  { timestamps: true, strict: "throw", collection: "platformtemplates" }
);

platformTemplateSchema.index({ key: 1, version: 1 }, { unique: true, name: "uniq_platform_template_version" });

platformTemplateSchema.pre("validate", function checkDefinition(next) {
  if (!this.isNew) return next();
  try {
    const plain = { key: this.key, version: this.version, components: this.components.map((c) => c.toObject()) };
    validateDefinition(plain);
    if (templateContentHash(plain) !== this.contentHash) throw new Error("PlatformTemplate contentHash does not match its components");
    if (this.status !== "published") throw new Error("a PlatformTemplate is created published");
  } catch (err) {
    return next(err);
  }
  return next();
});

platformTemplateSchema.pre("save", function refuseRepublish(next) {
  if (this.isNew) return next();
  const changed = this.modifiedPaths().filter((p) => !MUTABLE_FIELDS.has(p.split(".")[0]));
  if (changed.length) return next(new Error("a published PlatformTemplate is immutable"));
  if (this.isModified("status") && this.status !== "retired") return next(new Error("a PlatformTemplate can only be retired"));
  return next();
});

// Query updates: only published -> retired, and nothing else.
function refuseQueryChange(next) {
  const u = this.getUpdate() || {};
  if (Array.isArray(u)) return next(new Error("a published PlatformTemplate is immutable"));
  const keys = [];
  for (const [k, v] of Object.entries(u)) {
    if (!k.startsWith("$")) keys.push(k);
    else if (k === "$set") keys.push(...Object.keys(v || {}));
    else if (k === "$setOnInsert") keys.push(...Object.keys(v || {}).filter((f) => f !== "createdAt")); // timestamps
    else return next(new Error(`a published PlatformTemplate is immutable (${k})`));
  }
  const bad = keys.filter((k) => !MUTABLE_FIELDS.has(k.split(".")[0]));
  if (bad.length || IMMUTABLE_FIELDS.some((f) => keys.includes(f))) return next(new Error("a published PlatformTemplate is immutable"));
  const status = (u.$set && u.$set.status) || u.status;
  if (status !== undefined && status !== "retired") return next(new Error("a PlatformTemplate can only be retired"));
  return next();
}
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"]) {
  platformTemplateSchema.pre(op, refuseQueryChange);
}
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  platformTemplateSchema.pre(op, (next) => next(new Error("PlatformTemplate records are never deleted (retire instead)")));
}
platformTemplateSchema.pre("bulkWrite", (next) => next(new Error("PlatformTemplate bulk writes are not allowed")));

const PlatformTemplate = mongoose.model("PlatformTemplate", platformTemplateSchema);
PlatformTemplate.STATUSES = STATUSES;

module.exports = PlatformTemplate;
