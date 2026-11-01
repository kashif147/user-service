# P5 — tenant roles from a versioned manifest (foundation, NOT active)

Status: implemented and tested; **not called** by tenant creation, any route or any template. `standard-tenant` v2 is
design-only (not published). The canonical role content (`config/tenantRoles.v1.json`) is **not** part of this
foundation: it ships separately and stays held until the portal-authorization security remediation and the owner's
content decisions are complete. Without it, `ensureTenantRoles` fails closed (`MANIFEST_NOT_FOUND`).

## 1. Manifest format and validator — `services/tenantRoleManifest.js`

- Identity: `version` + sha256 of the **raw file bytes** (same rule as the grid-default components).
- Format: `{ kind, version, source, invariants, roles[] }`. Each role is exactly
  `{ code, name, description, category, level, isSystemRole, tenantAdmin, permissions[] }`.
- The whole manifest is validated before anything is used. It refuses:
  - retired codes (`constants/retiredRoleCodes.js`, i.e. SU);
  - wildcards, ObjectId entries, non-stable / `resource:action` forms, and platform permissions;
  - unsorted or duplicate permissions;
  - anything other than exactly one `tenantAdmin` (ASU, category SYSTEM, `isSystemRole`); any other SYSTEM / system role;
  - duplicate codes or names, placeholder text, extra or missing keys, and out-of-range levels.
- `catalogueProblems()` requires every permission to be an **active**, non-platform catalogue code.

## 1a. Canonical content — `config/tenantRoles.v1.json` (PROVISIONAL, HELD — do not merge)

- sha256 **5fc7f548ccdceb3359af46d88e8847e799df792196d68a16c711e3654c90e43f** — provisional: it changes until the
  portal authorization remediation and the owner's content decisions close.
- 24 roles (NOTIFIER and AI excluded, no SU). Categories:

  | Roles | Category |
  |---|---|
  | ASU | SYSTEM |
  | staff (all other roles) | CRM |
  | MEMBER / NON-MEMBER | PORTAL |

- Owner decisions applied (D1–D8 and 2026-11-01):
  - ASU description: "Assistant Super User: highest administrator of its own tenant"; no TENANT_DELETE anywhere.
  - REO: mutation-free; additions PRODUCT_READ, APPLICATION_READ, CRM_MEMBER_READ, CRM_ACCESS approved;
    **TENANT_READ is conditional** — do not rely on it until the PDP category rule is fixed (today the category rule
    denies `tenant:read` to every non-ASU CRM role).
  - MO: ISSUES_READ, PRODUCT_READ, PRODUCT_TYPE_READ, PRICING_READ approved; **ISSUES_WRITE not approved** (it would
    allow any issue type; complaint creation needs a narrower design); USER_READ kept provisionally (to be proven);
    PAYMENTS_WRITE stays removed.
  - **MEMBER / NON-MEMBER: NOT FROZEN** — carried with dead legacy codes dropped only, pending the portal
    tenant/object authorization security remediation.
  - No inactive, test-like or duplicate/dead catalogue code is referenced.
- Tests: `tests/tenantRoles.p5.committedManifest.test.js`, `tests/tenantRoles.p5.pdp.test.js` (fixture
  `tests/fixtures/p5-dev-permission-catalogue.json`: DEV catalogue codes/categories + live REO/MO/MEMBER/NON-MEMBER
  code sets only, no data).

## 2. `ensureTenantRoles(targetTenantId, { version, sha256 })` — `services/tenantRoleProvisioning.js`

1. **Inputs:**
   - an explicit internal tenant id (24-hex) of an existing tenant — never an org code, Entra tid or email domain;
   - version and sha256 that are both exact (otherwise `MANIFEST_DIGEST_MISMATCH`).
2. **Validation first:** the manifest and the catalogue are validated before the first insert. Any problem means nothing is written.
3. **Matching:** roles are matched by `{tenantId, code}` on the target tenant only.
   - An existing role (active → `EXISTS`, soft-deleted → `EXISTS_INACTIVE`) is **skipped and never updated**, which preserves tenant customisation.
   - A name already used by another role is reported as conflict `NAME_TAKEN`.
4. **Insert:** the remaining roles are inserted in **one transaction** (all or nothing).
   - They are tenant-owned, `createdBy: platform:provisioning`, and carry the origin marker
     `provisioning { component: user-service:tenant-roles, manifestVersion, manifestSha256, insertedAt }`.
5. **After every successful call** (also a replay that inserted nothing) the target tenant's role caches are
   invalidated, so a retry repairs an earlier failed invalidation.
6. **Result:** `{ tenantId, manifestVersion, manifestSha256, inserted, skipped, conflicts, cache }`.

### Failure model (deterministic, recoverable; never a half-created role set)

| Situation | Outcome | Persisted | Recovery |
|---|---|---|---|
| manifest absent from the build | `MANIFEST_NOT_FOUND` | nothing | ship the manifest |
| invalid manifest / retired code / platform permission / wildcard | `TENANT_ROLE_MANIFEST_INVALID` | nothing | fix the manifest |
| requested version / sha256 differ from the local manifest | `MANIFEST_DIGEST_MISMATCH` (+ expected identity) | nothing | request the right identity |
| a code missing or inactive in the catalogue | `TENANT_ROLE_MANIFEST_INVALID` (problems list) | nothing | fix the catalogue, repeat |
| bad / unknown tenant | `INVALID_TENANT_ID` / `TENANT_NOT_FOUND` | nothing | — |
| concurrent insert (duplicate key) | `CONCURRENT_ROLE_WRITE` | nothing from this call | repeat (idempotent) |
| any other transaction failure, process crash before commit | `ROLE_TRANSACTION_FAILED` / aborted transaction | nothing | repeat |
| duplicate invocation / retry after success | all `EXISTS`, collection unchanged | — | — |
| cache invalidation fails | roles **committed**; `cache: { invalidated: false, failed, code: CACHE_INVALIDATION_FAILED }` | the role set | repeat: re-invalidates |

## 3. Model guards (`models/role.model.js`)

| Guard | Behaviour |
|---|---|
| Ownership | A15 `tenantOwnershipPlugin`: a role never changes tenant (`TENANT_IMMUTABLE`). |
| Code immutability (manifest-origin roles only) | Every Mongoose path is covered: `$set`, top-level, `$unset`, `$rename`, pipelines, replacement, `bulkWrite`, `save`. Error: `ROLE_CODE_IMMUTABLE`, which the role controller maps to 409. Names, descriptions and permissions stay tenant-customisable. Roles without the marker keep today's behaviour. |
| Origin marker | Written only at insert. No update may add, change, remove or forge it (`ROLE_ORIGIN_IMMUTABLE`). |

## 4. Caches (`services/tenantRoleCache.js`)

- **Cleared per tenant, never a global flush:** `role_hierarchy:<tenant>` and `role_permissions:<tenant>:*`.
- **Outcome:** `{ invalidated: true, failed: [] }` only when every step succeeded; otherwise
  `{ invalidated: false, failed: [cache] }`. Never thrown.
- **When:** after every successful `ensureTenantRoles` call, and after every role create / update / delete /
  permission update (the role CRUD invalidation goes beyond the P5 minimum and is declared as such).
- **Not invalidated:**
  - **PDP decision cache.** Its keys are derived from the token's verified roles and permissions, and the PDP reads no role rows. A token issued after a change therefore never reads a stale decision.
  - **`cacheInvalidationService.invalidateTenantCache`.** Its /me step calls a `delPattern` that doesn't exist, and its policy step blocks about 55 s on Redis reconnects when Redis is down. It is separate technical debt and must stay uncalled.

## 5. `standard-tenant` v2 (design only — do not publish)

- **Components:** the 7 v1 components plus `user-service:tenant-roles` (action `ensure-roles`, manifest version + sha).
- **Order:** v1 stays byte-identical. v2 needs an explicit order:

  | Order | Component | Action |
  |---|---|---|
  | 1 | `user-service:tenant-roles` | `ensure-roles` |
  | 2–8 | the existing grid-default components, in their v1 relative order | `ensure-defaults` |

- **Execution:** the roles component runs locally inside user-service through component-registry metadata (no
  broker hop), with the same step key, run/attempt state, manifest identity check, result and failure codes.
- The role-manifest hash stays provisional until the security remediation closes.

## 6. Cutover (separate PR, after manifest approval)

- **`createTenant`:** stops calling the live MAIN clone and `ensureTenantAdminOnNewTenant`; roles then come from provisioning.
- **Tests:** update `tenantAdminParity.mongo` and the Z9 source-guard regex, without weakening the SU guard.
- **Existing tenants:** not normalised (migration debt). DEVDIRB receiving ASU needs explicit approval.
