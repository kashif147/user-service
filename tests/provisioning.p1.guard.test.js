/**
 * Phase B / P1 - structural guarantees of the provisioning control plane (no DB):
 *  - the provisioning modules have no path to users, roles (SU or otherwise) or permissions, no HTTP client and
 *    no event publish other than the platform audit: P1 dispatches nothing (that is P3 / P4);
 *  - a tenant role can never hold platform:provisioning:admin (Z3 write guard on the real Role model);
 *  - the component registry declares insert-missing-only, tenant-scoped, version-aware, digest-pinned
 *    semantics and never a tenantless default; the template definition references only registered components.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
mongoose.set("bufferCommands", false);

const Role = require("../models/role.model");
const { COMPONENTS, GRID_SEMANTICS, resolveComponentRef } = require("../constants/provisioningComponents");
const { DEFINITIONS, templateContentHash, validateDefinition } = require("../constants/platformTemplates");
const { isPlatformPermission } = require("../constants/platformPermissions");

const ROOT = path.join(__dirname, "..");
const FILES = [
  "constants/provisioningComponents.js",
  "constants/platformTemplates.js",
  "models/platformTemplate.model.js",
  "models/provisioningRun.model.js",
  "services/provisioningRunService.js",
  "controllers/provisioning.controller.js",
  "routes/provisioning.routes.js",
  "scripts/platform-template.js",
];
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const requires = (f) => [...src(f).matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);

test.each(FILES)("%s never reaches users, roles, permissions, other services or a dispatch path", (f) => {
  const reqs = requires(f);
  for (const r of reqs) {
    expect(r).not.toMatch(/(user|role|permission|directoryClaim|platformPrincipal)\.model|roleAssignment|tenant\.handler|axios|node-fetch|^https?$|policy-middleware/i);
    expect(r).not.toMatch(/^\.\.\/\.\.\//); // never into another service's tree
  }
  // the only RabbitMQ use is the platform audit (lazy, inside platformAuditService) and the script's publisher init
  if (f !== "scripts/platform-template.js") expect(reqs).not.toContain("../rabbitMQ");
  const code = src(f);
  expect(code).not.toMatch(/x-internal-request|x-api-key|publishDomainEvent\(|fetch\(|\.insertMany\(|"SU"|'SU'/);
});

test("a tenant role can never be given platform:provisioning:admin (Z3 guard on the real Role model)", async () => {
  const role = new Role({ tenantId: "68cbf7806080b4621d469d34", name: "N", code: "N", description: "d", category: "CRM", permissions: ["platform:provisioning:admin"] });
  await expect(role.validate()).rejects.toThrow();
  expect(isPlatformPermission("platform:provisioning:admin")).toBe(true);
});

test("registry: 7 service-owned grid defaults, each insert-missing-only, tenant scoped, version aware, digest pinned, never tenantless", () => {
  expect(COMPONENTS.map((c) => c.service).sort()).toEqual(["account-service", "events-service", "issue-service", "notification-service", "profile-service", "reporting-service", "subscription-service"]);
  for (const c of COMPONENTS) {
    expect(c.semantics).toBe(GRID_SEMANTICS);
    expect(c).toMatchObject({ entryPoint: "ensureTenantDefaults", manifestVersion: 1, kind: "grid-system-defaults" });
    expect(c.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.templateTypes.length).toBeGreaterThan(0);
    expect(Object.isFrozen(c)).toBe(true);
  }
  expect(GRID_SEMANTICS).toEqual({ insertMissingOnly: true, skipExisting: true, overwritesCustomisation: false, tenantScoped: true, versionAware: true, idempotent: true, createsTenantless: false });
  // the transitional OBJECT_ID mode is reporting only (its legacy ObjectId rows stay untouched)
  expect(COMPONENTS.filter((c) => c.objectIdTenantRows === "legacy").map((c) => c.service)).toEqual(["reporting-service"]);
  // types with no shared default stay code-defined and are NOT provisioned (owner decision E)
  const types = COMPONENTS.flatMap((c) => c.templateTypes);
  for (const t of ["refunds", "writeoffs", "generalledger", "eventssummary", "application", "issuessummary", "creditnotes@profile", "membershiplisting"]) expect(types).not.toContain(t);
});

test("template definitions: deterministic content hash, only exactly-registered components, no tenant data", () => {
  for (const d of DEFINITIONS) {
    expect(validateDefinition(d)).toBe(true);
    expect(templateContentHash(d)).toBe(templateContentHash(JSON.parse(JSON.stringify(d))));
    for (const c of d.components) expect(resolveComponentRef(c)).not.toBeNull();
    expect(JSON.stringify(d)).not.toMatch(/tenantId|columns|filters|"_id"/);
  }
  const d = DEFINITIONS[0];
  expect(resolveComponentRef({ ...d.components[0], version: 2 })).toBeNull();
  expect(resolveComponentRef({ ...d.components[0], manifestSha256: "0".repeat(64) })).toBeNull();
  expect(() => validateDefinition({ ...d, components: [...d.components, d.components[0]] })).toThrow();
});
