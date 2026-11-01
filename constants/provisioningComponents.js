/**
 * Phase B / P1: the provisioning component registry - the service-owned tenant defaults a PlatformTemplate
 * may reference. Static, reviewed code: nothing here is read from a database, a live tenant or a CRM working
 * tree, and no tenant customisation is ever read back into it.
 *
 * Each component is ONE owning service's versioned canonical manifest plus that service's internal
 * `ensureTenantDefaults(tenantId, manifestVersion)` entry point (services/tenantGridDefaults.js there;
 * account: src/services/tenantGridDefaults.cjs). Declared semantics, enforced by the owning service's kit
 * and its real-mongod suite:
 *   - insert missing only; an existing active tenant default (possibly customised) is skipped, never updated
 *   - tenant scoped: one explicit internal tenant id (24 lowercase hex); never inferred, never tenantless
 *   - version aware: a request for a manifest version the service does not ship is refused
 *   - idempotent: a replay inserts nothing
 *
 * manifestSha256 = sha256 of the manifest file's raw bytes as committed on the owning service's develop
 * (`git show origin/develop:<manifestPath> | shasum -a 256`). A provisioning consumer (P4) must compute the
 * same digest over the file it ships and refuse a step whose digest differs - the version number alone does
 * not pin content. Changing a manifest file (even its notes) changes the digest: re-pin here and publish a
 * NEW template version; a published template is never edited.
 *
 * P1 registers capabilities only. Nothing in user-service calls another service: dispatch is the P3
 * transactional outbox (tenant.provisioning.* events, rabbitmq-middleware M1) and the per-service consumers
 * are P4. Components owned by user-service itself (tenant roles, ASU permission set, tenant settings) are not
 * registered yet: tenant roles are still cloned from the live MAIN tenant's rows, which is not a versioned
 * source (P5 prerequisite).
 */
const GRID_SEMANTICS = Object.freeze({
  insertMissingOnly: true,
  skipExisting: true,
  overwritesCustomisation: false,
  tenantScoped: true,
  versionAware: true,
  idempotent: true,
  createsTenantless: false,
});

const grid = (service, { manifestPath, kitPath, collection, templateTypes, manifestSha256, objectIdTenantRows = "refuse" }) =>
  Object.freeze({
    key: `${service}:grid-system-defaults`,
    service,
    kind: "grid-system-defaults",
    entryPoint: "ensureTenantDefaults",
    kitPath,
    manifestPath,
    manifestVersion: 1,
    manifestSha256,
    collection,
    templateTypes: Object.freeze([...templateTypes]),
    objectIdTenantRows,
    semantics: GRID_SEMANTICS,
  });

const COMPONENTS = Object.freeze([
  grid("account-service", {
    kitPath: "src/services/tenantGridDefaults.cjs",
    manifestPath: "src/config/gridSystemDefaults.v1.json",
    collection: "templates",
    templateTypes: ["creditnotes", "journaladjustments", "onlinepayment", "reconciliation"],
    manifestSha256: "f229027749c8e37185d7828126da1847588b69e593236b5b3aba4514d7c7fd2f",
  }),
  grid("events-service", {
    kitPath: "services/tenantGridDefaults.js",
    manifestPath: "config/gridSystemDefaults.v1.json",
    collection: "templates",
    templateTypes: ["attendees"],
    manifestSha256: "b6439200fb4b5ab3806647db6b25da52753e83ea8bd030a91d4f1db21dd447ca",
  }),
  grid("profile-service", {
    kitPath: "services/tenantGridDefaults.js",
    manifestPath: "config/gridSystemDefaults.v1.json",
    collection: "templates",
    templateTypes: ["profile"],
    manifestSha256: "c3e0404b77ec8a57b0eb883d515a9fdbd51afe507d03395c46d496efd7b39b65",
  }),
  grid("reporting-service", {
    kitPath: "services/tenantGridDefaults.js",
    manifestPath: "config/gridSystemDefaults.v1.json",
    collection: "reportinggridtemplates",
    templateTypes: ["workplacebreakdownreport", "debtorslistreport"],
    manifestSha256: "5c7e120ea45cafff5e32289f8638774ef59e13d0cabb63cd167816d6e084d3b0",
    objectIdTenantRows: "legacy",
  }),
  grid("subscription-service", {
    kitPath: "services/tenantGridDefaults.js",
    manifestPath: "config/gridSystemDefaults.v1.json",
    collection: "templates",
    templateTypes: ["members"],
    manifestSha256: "bac771fb8430ee6a98b986302e72daadebbf5096ce5c5e9ec9de7e3436197f36",
  }),
  grid("notification-service", {
    kitPath: "services/tenantGridDefaults.js",
    manifestPath: "config/gridSystemDefaults.v1.json",
    collection: "notificationfiltertemplates",
    templateTypes: ["notification"],
    manifestSha256: "7b54ea500d5e1e268099d03a01e84c8f143a65384a1a7191891d3db54c290020",
  }),
  grid("issue-service", {
    kitPath: "services/tenantGridDefaults.js",
    manifestPath: "config/issueGridSystemDefaults.v1.json",
    collection: "templates",
    templateTypes: ["issuesclosed", "issuescomplaints", "issuesftp", "issuesir", "issuesdataprotection"],
    manifestSha256: "16205a59939281a047657d49ff9da94cb50859d7c9728dcf6caf58bef1c3c450",
  }),
]);

const BY_KEY = new Map(COMPONENTS.map((c) => [c.key, c]));

const getComponent = (key) => BY_KEY.get(key) || null;

/** The registry entry a template reference points at, or null when the reference is not exactly registered. */
function resolveComponentRef(ref) {
  const c = ref && getComponent(ref.component);
  if (!c) return null;
  if (ref.version !== c.manifestVersion || ref.manifestSha256 !== c.manifestSha256 || ref.service !== c.service) return null;
  return c;
}

module.exports = { COMPONENTS, GRID_SEMANTICS, getComponent, resolveComponentRef };
