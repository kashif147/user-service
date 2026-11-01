/**
 * P5: the versioned tenant-roles manifest (config/tenantRoles.v<N>.json) - the immutable provisioning source for a
 * tenant's roles. Replaces the legacy live MAIN-tenant clone as the source of truth; NOT wired into tenant creation
 * or any template yet (standard-tenant v2 is design-only).
 *
 * Identity of a manifest = version + sha256 of the RAW file bytes (same rule as the grid-default components,
 * constants/provisioningComponents.js). validateManifest() is pure and total: every rule is checked before anything
 * is written. validateAgainstCatalogue() checks every permission code against the ACTIVE permission catalogue.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isPlatformNamespace } = require("../constants/permissionClassification");
const { isRetiredRoleCode } = require("../constants/retiredRoleCodes");

const KIND = "user-service:tenant-roles";
const MANIFEST_PATH = path.join(__dirname, "..", "config", "tenantRoles.v1.json");
const ROLE_KEYS = ["category", "code", "description", "isSystemRole", "level", "name", "permissions", "tenantAdmin"];
const TOP_KEYS = ["invariants", "kind", "roles", "source", "version"];
const CATEGORIES = new Set(["PORTAL", "CRM", "SYSTEM"]);
const TENANT_ADMIN_CODE = "ASU";
const ROLE_CODE = /^[A-Z][A-Z0-9-]{0,31}$/;
const PERMISSION_CODE = /^[A-Z][A-Z0-9_.]{1,79}$/; // stable CODE_FORMAT; no spaces, no wildcards, no ":" forms
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const PLACEHOLDER = /\b(todo|tbd|fixme|placeholder|lorem|xxx)\b/i;

class TenantRoleManifestError extends Error {
  constructor(problems) {
    super(`Invalid tenant-roles manifest: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`);
    this.name = "TenantRoleManifestError";
    this.code = "TENANT_ROLE_MANIFEST_INVALID";
    this.status = 500;
    this.problems = problems;
  }
}

const sameKeys = (obj, keys) => JSON.stringify(Object.keys(obj).sort()) === JSON.stringify(keys);
const permissionToCanonical = (code) => code.toLowerCase().replace(/_/g, ":");

/** Every structural / invariant problem of a parsed manifest ([] = valid). */
function manifestProblems(m) {
  const p = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["manifest must be an object"];
  if (!sameKeys(m, TOP_KEYS)) p.push(`top-level keys must be exactly ${TOP_KEYS.join(",")}`);
  if (m.kind !== KIND) p.push(`kind must be ${KIND}`);
  if (!Number.isInteger(m.version) || m.version < 1) p.push("version must be a positive integer");
  if (typeof m.source !== "string" || !m.source.trim()) p.push("source is required");
  if (!m.invariants || typeof m.invariants !== "object") p.push("invariants object is required");
  if (!Array.isArray(m.roles) || m.roles.length === 0) return [...p, "roles must be a non-empty array"];
  const codes = new Set();
  const names = new Set();
  let admins = 0;
  m.roles.forEach((r, i) => {
    const at = `roles[${i}]${r && r.code ? ` (${r.code})` : ""}`;
    if (!r || typeof r !== "object" || !sameKeys(r, ROLE_KEYS)) { p.push(`${at}: keys must be exactly ${ROLE_KEYS.join(",")}`); return; }
    if (typeof r.code !== "string" || !ROLE_CODE.test(r.code)) p.push(`${at}: code must match ${ROLE_CODE}`);
    if (isRetiredRoleCode(r.code)) p.push(`${at}: retired role code is never provisioned`);
    if (codes.has(r.code)) p.push(`${at}: duplicate code`);
    codes.add(r.code);
    for (const f of ["name", "description"]) {
      if (typeof r[f] !== "string" || !r[f].trim() || r[f] !== r[f].trim()) p.push(`${at}: ${f} must be a non-empty trimmed string`);
      else if (PLACEHOLDER.test(r[f])) p.push(`${at}: ${f} contains placeholder text`);
    }
    if (typeof r.name === "string") {
      const n = r.name.trim().toLowerCase();
      if (names.has(n)) p.push(`${at}: duplicate name`);
      names.add(n);
    }
    if (!CATEGORIES.has(r.category)) p.push(`${at}: category must be PORTAL, CRM or SYSTEM`);
    if (!Number.isInteger(r.level) || r.level < 1 || r.level > 100) p.push(`${at}: level must be an integer 1-100`);
    if (typeof r.isSystemRole !== "boolean" || typeof r.tenantAdmin !== "boolean") p.push(`${at}: isSystemRole / tenantAdmin must be booleans`);
    if (r.tenantAdmin === true) {
      admins += 1;
      if (r.code !== TENANT_ADMIN_CODE) p.push(`${at}: only ${TENANT_ADMIN_CODE} may be the tenant admin role`);
    }
    if (r.code === TENANT_ADMIN_CODE && (r.tenantAdmin !== true || r.category !== "SYSTEM" || r.isSystemRole !== true)) p.push(`${at}: ${TENANT_ADMIN_CODE} must be tenantAdmin, category SYSTEM, isSystemRole`);
    if (r.code !== TENANT_ADMIN_CODE && (r.category === "SYSTEM" || r.isSystemRole === true)) p.push(`${at}: only ${TENANT_ADMIN_CODE} may be a SYSTEM / system role`);
    if (!Array.isArray(r.permissions) || r.permissions.length === 0) { p.push(`${at}: permissions must be a non-empty array`); return; }
    const sorted = [...r.permissions].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(r.permissions)) p.push(`${at}: permissions must be sorted`);
    if (new Set(r.permissions).size !== r.permissions.length) p.push(`${at}: duplicate permission`);
    for (const c of r.permissions) {
      if (typeof c !== "string") { p.push(`${at}: permission must be a string`); continue; }
      if (c.includes("*")) p.push(`${at}: wildcard permission ${c}`);
      else if (OBJECT_ID.test(c)) p.push(`${at}: ObjectId permission entry`);
      else if (!PERMISSION_CODE.test(c)) p.push(`${at}: permission ${JSON.stringify(c)} is not a stable code`);
      if (isPlatformNamespace(c) || isPlatformNamespace(permissionToCanonical(c)) || /^platform/i.test(c)) p.push(`${at}: platform permission ${c}`);
    }
  });
  if (admins !== 1) p.push(`exactly one tenantAdmin role is required (found ${admins})`);
  return p;
}

function validateManifest(m) {
  const problems = manifestProblems(m);
  if (problems.length) throw new TenantRoleManifestError(problems);
  return m;
}

/** Read + hash + validate. The sha256 covers the raw bytes exactly as committed. */
function loadManifest(file = MANIFEST_PATH) {
  const raw = fs.readFileSync(file);
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new TenantRoleManifestError([`not valid JSON (${e.message})`]);
  }
  validateManifest(manifest);
  return { manifest, sha256, version: manifest.version };
}

/** Every manifest permission code must be an ACTIVE catalogue entry. Returns the problems ([] = valid). */
async function catalogueProblems(manifest, PermissionModel = require("../models/permission.model")) {
  const all = [...new Set(manifest.roles.flatMap((r) => r.permissions))];
  const docs = await PermissionModel.find({ code: { $in: all } }).select({ code: 1, isActive: 1, resource: 1 }).lean();
  const byCode = new Map(docs.map((d) => [d.code, d]));
  const problems = [];
  for (const c of all) {
    const d = byCode.get(c);
    if (!d) problems.push(`permission ${c} is not in the catalogue`);
    else if (d.isActive === false) problems.push(`permission ${c} is inactive in the catalogue`);
    else if (isPlatformNamespace(String(d.resource || ""))) problems.push(`permission ${c} is a platform permission`);
  }
  return problems;
}

module.exports = { KIND, MANIFEST_PATH, TENANT_ADMIN_CODE, TenantRoleManifestError, manifestProblems, validateManifest, loadManifest, catalogueProblems };
