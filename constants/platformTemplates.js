/**
 * Phase B / P1: platform template DEFINITIONS - reviewed code, the only source a PlatformTemplate record is
 * published from (scripts/platform-template.js). A definition says which provisioning components, at which
 * pinned versions, a new tenant is expected to receive. It references service-owned versioned defaults
 * (constants/provisioningComponents.js) - it never contains tenant data, tenantless DB rows, lookups or any
 * value read back from a tenant.
 *
 * Versions are immutable: to change a template, add a NEW version here and publish it. A published version is
 * never edited (models/platformTemplate.model.js refuses it). contentHash is deterministic - sha256 over the
 * canonical JSON of { key, version, components } - so the DB record can always be checked against this file.
 */
const crypto = require("crypto");
const { COMPONENTS, resolveComponentRef } = require("./provisioningComponents");

const TEMPLATE_KEY = /^[a-z][a-z0-9-]{1,62}$/;

const ref = (component, order) => ({ order, component: component.key, service: component.service, version: component.manifestVersion, manifestSha256: component.manifestSha256, required: true });

// standard-tenant v1: every registered grid default, in a fixed order (owning-service alphabetical).
const DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "standard-tenant",
    version: 1,
    description: "Standard tenant: tenant-owned grid Save View system defaults of every owning service",
    components: Object.freeze(
      [...COMPONENTS].sort((a, b) => a.key.localeCompare(b.key)).map((c, i) => Object.freeze(ref(c, i + 1)))
    ),
  }),
]);

/** Canonical JSON: object keys sorted, array order kept. */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const COMPONENT_FIELDS = ["order", "component", "service", "version", "manifestSha256", "required"];

function templateContentHash({ key, version, components }) {
  const comps = components.map((c) => Object.fromEntries(COMPONENT_FIELDS.map((f) => [f, c[f]])));
  return crypto.createHash("sha256").update(canonicalJson({ key, version, components: comps })).digest("hex");
}

/** Throws unless the definition is well formed and every component is exactly a registered one. */
function validateDefinition(def) {
  if (!def || !TEMPLATE_KEY.test(String(def.key || ""))) throw new Error("template key must be lowercase kebab-case");
  if (!Number.isInteger(def.version) || def.version < 1) throw new Error("template version must be an integer >= 1");
  if (!Array.isArray(def.components) || def.components.length === 0) throw new Error("template needs components");
  const seen = new Set();
  def.components.forEach((c, i) => {
    if (c.order !== i + 1) throw new Error("component order must be 1..n");
    if (seen.has(c.component)) throw new Error(`duplicate component ${c.component}`);
    seen.add(c.component);
    if (!resolveComponentRef(c)) throw new Error(`component ${c.component} is not exactly a registered component version`);
    if (c.required !== true) throw new Error("P1 components are all required");
  });
  return true;
}

const getDefinition = (key, version) => DEFINITIONS.find((d) => d.key === key && d.version === version) || null;

module.exports = { DEFINITIONS, TEMPLATE_KEY, canonicalJson, templateContentHash, validateDefinition, getDefinition };
