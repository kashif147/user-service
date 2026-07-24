# RBAC engine — which implementation is actually live

This is the single most important thing to understand before touching authorization code here, both
for requests to this service and for how this service authorizes its own routes. There are four
parallel/candidate code paths and only two are live:

- **This service's own routes mostly use `helpers/policyAdapter.js`'s
  `defaultPolicyAdapter.middleware(resource, action)`** — an in-process call straight into
  `services/policyEvaluationService.js` (below). This covers role/permission/tenant/lookup/product/
  cache/tenantScoped routes. **Live.**
- **`routes/user.routes.js` and `middlewares/auth.js` instead use the published
  `@membership/policy-middleware` package** (`defaultPolicyMiddleware.requirePermission()`) — the
  same package every *other* service in the platform uses to call *this* service's
  `/policy/evaluate` over HTTP. So this service both hosts the PDP and, in one route file, calls its
  own PDP the same way an external client would. **Live.**
- **`controllers/policy.controller.js` is dead code** — `routes/policy.routes.js` has its own
  complete inline implementation of every `/policy/*` endpoint (`/evaluate`, `/evaluate-batch`,
  `/permissions/:resource`, `/health`, `/info`, `/ui/initialize`, cache endpoints) and never
  `require`s the controller file. The controller's `evaluatePolicy` export is also missing the
  gateway-header branch the route has (it only handles token-based requests) — editing the
  controller expecting it to affect `/policy/evaluate` has no effect; the live logic is entirely in
  `routes/policy.routes.js`.
- **`sdks/node-policy-client.js` (and the React/React Native hook docs built on it) is essentially
  unused in this codebase** — its only mount point, `routes/role-policy.routes.js`, is never
  `require`d in `routes/index.js`. It's exercised only by files under `examples/`. Don't confuse it
  with `helpers/policyAdapter.js`, the thing actually protecting routes.

When fixing an authorization bug, first work out which of these four paths the failing request
actually goes through — grep for `requirePermission`/`policyAdapter`/`policy.controller` in the
route file's imports; that tells you immediately.

## Policy evaluation engine (`services/policyEvaluationService.js`)

The real PDP logic. `evaluatePolicyWithHeaders()` runs whenever `x-jwt-verified: true` +
`x-auth-source: gateway|azuread` are present — i.e. essentially always, for gateway-routed traffic.
Its own doc comment states gateway headers are the single source of truth: it never reads
`userId`/`tenantId`/roles/permissions from the JWT, DB, or cache, only from headers, and
`routes/policy.routes.js` passes `context.correlationId` only, never letting a caller's
`context.tenantId`/`userId` override the header values. `evaluatePolicy()` (token-based) is the
legacy fallback for direct/non-gateway callers.

`applyPolicyRules()` runs three sequential checks that **all** must PERMIT — a denial can come from
any one of them, so when debugging "why was this denied" check which stage produced the reason
string:

1. `evaluateResourcePolicy` — does the resource have any permissions defined at all, and does the
   caller's `userType` category (`CRM`/`PORTAL`/`ADMIN`/`GENERAL`) match the permission's category
   (with `COMMUNICATION`/`NOTIFICATION`/`API`/`GENERAL` as shared categories both PORTAL and CRM can
   use)? Also handles the `tenant` resource specially: `SU` gets global access, `ASU` is restricted
   to `tenantId === userTenantId`.
2. `evaluateActionPolicy` — either an exact canonical permission match (`{resource}:{action}`) in the
   caller's `permissions` array, or a fallback minimum role level (`read`:1, `create`/`write`/
   `update`:30, `delete`:60, `admin`:80, `super_admin`:100) via `roleHierarchyService`.
3. `evaluatePermissionPolicy` — the specific `{resource}:{action}` permission must exist in the
   database (`permissionsService`) and be present in the caller's `permissions` array (or `"*"`).

`SU` role always short-circuits to PERMIT before any of this via
`roleHierarchyService.isSuperUser()`. `AUTH_BYPASS_ENABLED=true` skips authorization but **still
validates the JWT is well-formed** — it is a skip of the permission checks only, never a blanket
"accept anything." Evaluation has a hard 3-second timeout (`Promise.race`) that DENIES on timeout
rather than hanging.

## Cache staleness after a permission/role change — no automatic invalidation exists

Three independent Redis-backed caches exist (`services/cacheService.js` generic,
`services/policyCache.js` for PDP decisions, `services/lookupCacheService.js`), all with graceful
in-memory-fallback if Redis is down. **`services/cacheInvalidationService.js` — built specifically to
clear `/me` and policy caches after a role/permission edit — is never imported anywhere in this
codebase.** `role.controller.js`/`permission.controller.js` don't call it, or anything equivalent,
after a write. Combined with `@membership/policy-middleware`'s own 5-minute client-side cache in every
*other* service, a role or permission change can take up to ~10 minutes to actually take effect
platform-wide, with zero automatic invalidation. The only way to force it sooner today: `POST
/api/cache/clear` (admin-only, `controllers/cache.controller.js`) plus every consuming service
independently clearing its own policy-middleware cache — nothing here triggers that for them. If
asked to fix "permission changes don't take effect immediately," the fix is wiring
`cacheInvalidationService.js` into the role/permission write paths, not adding more caching.
