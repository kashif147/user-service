const mongoose = require("mongoose");
const fieldWriteGuard = require("./plugins/fieldWriteGuard");
const { isPlatformNamespace, canonicalPermission } = require("../constants/permissionClassification");
const { RolePrivilegeError } = require("../errors/RolePrivilegeError");
const { tenantOwnershipPlugin } = require("./plugins/tenantOwnership.plugin");
const { AppError } = require("../errors/AppError");

// P5: roles inserted by the tenant-roles provisioning component (services/tenantRoleProvisioning.js) carry this
// origin marker. Their `code` is the stable identity a provisioning replay matches on, so it can never change.
const TENANT_ROLES_COMPONENT = "user-service:tenant-roles";
const ROLE_CODE_IMMUTABLE = "ROLE_CODE_IMMUTABLE";
const ROLE_ORIGIN_IMMUTABLE = "ROLE_ORIGIN_IMMUTABLE";

const RoleSchema = new mongoose.Schema({
  // Tenant isolation - mandatory field
  tenantId: {
    type: String,
    required: true,
    index: true,
  },

  name: {
    type: String,
    required: true,
    trim: true,
  },
  code: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    enum: ["PORTAL", "CRM", "SYSTEM"],
    required: true,
  },
  level: {
    type: Number,
    default: 1,
    min: 1,
    max: 100,
    index: true,
  },
  permissions: [
    {
      type: String,
    },
  ],
  isActive: {
    type: Boolean,
    default: true,
  },
  isSystemRole: {
    type: Boolean,
    default: false,
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

  // P5 provisioning origin (absent on every role not inserted by ensureTenantRoles). Immutable once set.
  provisioning: {
    type: new mongoose.Schema(
      {
        component: { type: String, required: true },
        manifestVersion: { type: Number, required: true },
        manifestSha256: { type: String, required: true },
        insertedAt: { type: Date, required: true },
      },
      { _id: false }
    ),
    default: undefined,
    immutable: true,
  },
});

// Compound indexes for tenant isolation
RoleSchema.index({ tenantId: 1, code: 1 }, { unique: true }); // Unique role code per tenant
RoleSchema.index({ tenantId: 1, name: 1 }, { unique: true }); // Unique role name per tenant

RoleSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Phase B / Z3: a tenant role can never hold a platform-namespace permission (today's catalogue or any
// future platform:* code), on any Mongoose write path - not only through handlers/role.handler.js.
// ObjectId entries reference the Permission catalogue, which can never contain a platform code
// (models/permission.model.js). See constants/permissionClassification.js.
RoleSchema.plugin(fieldWriteGuard, {
  fields: ["permissions"],
  check(values) {
    const platform = values.filter((v) => typeof v === "string" && isPlatformNamespace(v));
    if (platform.length) {
      throw new RolePrivilegeError(
        `Platform permissions cannot be granted to a tenant role: ${[...new Set(platform.map(canonicalPermission))].join(", ")}`
      );
    }
  },
});

// P5: a role never moves between tenants (A15 ownership guard, as on User / ProductType / provisioning models).
RoleSchema.plugin(tenantOwnershipPlugin, { modelName: "Role" });

// P5: the code of a manifest-origin role is immutable on every Mongoose write path. Names / labels / description
// remain tenant customisation. Roles without the origin marker keep today's behaviour (code editable by admins).
const codeImmutable = (op, reason) => {
  console.warn(JSON.stringify({ level: "warn", message: "RoleCodeImmutable", eventType: "role.code_immutable", op, reason }));
  return new AppError("The code of a provisioned role cannot be changed", 409, ROLE_CODE_IMMUTABLE, { op, reason });
};
const originImmutable = (op) => {
  console.warn(JSON.stringify({ level: "warn", message: "RoleOriginImmutable", eventType: "role.origin_immutable", op }));
  return new AppError("The provisioning origin of a role cannot be changed", 409, ROLE_ORIGIN_IMMUTABLE, { op });
};
const touchesKey = (obj, key) => obj != null && typeof obj === "object" && Object.keys(obj).some((k) => k === key || k.startsWith(`${key}.`));
/** The new code an update would write (undefined = code untouched); throws on code removal / rename / pipelines. */
function proposedCode(update, op) {
  if (update == null || typeof update !== "object") return undefined;
  if (Array.isArray(update)) {
    if (JSON.stringify(update).includes('"code"')) throw codeImmutable(op, "pipeline_update_touches_code");
    return undefined;
  }
  let next;
  for (const [k, body] of Object.entries(update)) {
    if (k === "code") next = body;
    else if (k === "$set" && body && Object.prototype.hasOwnProperty.call(body, "code")) next = body.code;
    else if (k.startsWith("$") && k !== "$set" && k !== "$setOnInsert" && touchesKey(body, "code")) {
      throw codeImmutable(op, `${k.slice(1)}_on_code`);
    } else if (k === "$rename" && body && Object.values(body).includes("code")) throw codeImmutable(op, "rename_to_code");
  }
  return next;
}
const ROLE_QUERY_OPS = ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"];
// The origin marker is written only at insert (ensureTenantRoles); no update may add, change or remove it.
const touchesOrigin = (update) => {
  if (update == null || typeof update !== "object") return false;
  if (Array.isArray(update)) return JSON.stringify(update).includes("provisioning");
  return Object.entries(update).some(([k, body]) => k === "provisioning" || k.startsWith("provisioning.") ||
    (k.startsWith("$") && (touchesKey(body, "provisioning") || (k === "$rename" && body && Object.values(body).some((v) => String(v).startsWith("provisioning"))))));
};
RoleSchema.pre(ROLE_QUERY_OPS, async function roleCodeImmutableQueryGuard() {
  const op = this.op;
  const update = this.getUpdate();
  const replacement = op === "replaceOne" || op === "findOneAndReplace";
  if (!replacement && touchesOrigin(update)) throw originImmutable(op);
  if (replacement && (await this.model.exists({ ...this.getFilter(), provisioning: { $exists: true } }))) throw originImmutable(op);
  const next = replacement ? (update && update.code) : proposedCode(update, op);
  if (next === undefined && !replacement) return;
  const filter = { ...this.getFilter(), "provisioning.component": TENANT_ROLES_COMPONENT };
  if (!replacement) filter.code = { $ne: typeof next === "string" ? next.trim() : next };
  const hit = await this.model.exists(filter);
  if (hit) throw codeImmutable(op, replacement ? "replacement_of_provisioned_role" : "code_change");
});
RoleSchema.pre("bulkWrite", function roleCodeImmutableBulkGuard(next, ops) {
  const list = Array.isArray(ops) ? ops : [];
  const bad = list.some((o) => {
    const k = o && Object.keys(o)[0];
    const body = k && o[k];
    if (!body) return false;
    if (k === "replaceOne") return true;
    if (k === "updateOne" || k === "updateMany") {
      if (touchesOrigin(body.update)) throw originImmutable("bulkWrite");
      return proposedCode(body.update, "bulkWrite") !== undefined;
    }
    return false;
  });
  // Bulk role updates of code / replacements cannot be checked per document here: refuse them (no caller uses them).
  if (bad) return next(codeImmutable("bulkWrite", "bulk_code_change"));
  next();
});
RoleSchema.pre("save", function roleCodeImmutableSaveGuard() {
  if (this.isNew) return;
  if (this.isModified("provisioning")) throw originImmutable("save");
  if (!this.isModified("code")) return;
  if (this.provisioning && this.provisioning.component === TENANT_ROLES_COMPONENT) throw codeImmutable("save", "code_change");
});

module.exports = mongoose.model("Role", RoleSchema);
module.exports.TENANT_ROLES_COMPONENT = TENANT_ROLES_COMPONENT;
module.exports.ROLE_CODE_IMMUTABLE = ROLE_CODE_IMMUTABLE;
module.exports.ROLE_ORIGIN_IMMUTABLE = ROLE_ORIGIN_IMMUTABLE;
