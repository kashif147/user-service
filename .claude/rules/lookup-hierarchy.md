# Lookup / hierarchy system

Two levels of nesting: `LookupType` can itself have a parent `LookupType` (`ParentlookuptypeId`), and
within a type, individual `Lookup` values chain via `Parentlookupid` (e.g. Region → Branch → Work
Location). `controllers/lookup.controller.js`'s `buildAncestryHierarchy` walks that chain to the root
for `GET /api/lookup/:id/hierarchy` and `GET /api/lookup/by-type/:lookuptypeId/hierarchy`.

**`controllers/lookuptype.ontroller.js` is a real, required typo in the filename**
(`routes/lookuptype.router.js` `require`s that exact misspelled path) — don't rename it without
updating the `require`, or the route breaks.

There is no bulk-lookup-by-ids or internal endpoint: other services resolve lookup IDs by fetching
the entire cached list (`GET /api/lookup`, Redis-backed via `lookupCacheService`) and filtering
client-side, or by calling the by-type hierarchy endpoint instead.

**Resolve by stable code, never by a hard-coded ObjectId** (Phase A / A10): callers use
`GET /api/lookup/by-type-code/:typeCode/hierarchy` (e.g. `WORKLOC`, `001`) and
`GET /api/products/by-type-code/:typeCode[?productCode=4080]` (e.g. `MEM`). Both take the tenant from
the trusted context only (`requireTenant`), answer 404 for an unknown code, and return the same body
as the by-id route. Lookup rows are still global until Phase D; then the code resolver filters by
tenant with the same contract.

**Lookup cache keys are tenant-keyed and versioned** (Phase A / A11):
`lookup:v2:<tenantId>:…`, `lookuptype:v2:<tenantId>:…` (incl. `code:<CODE>`), `hierarchy:v2:<tenantId>:<id>`,
`lookuptype-hierarchy:v2:<tenantId>:type:<id>`. Always pass the trusted `req.ctx.tenantId`; with no
tenant nothing is cached. Lookup/lookuptype writes clear every tenant's entries (shared data). The
pre-v2 global keys are purged at startup (`purgeLegacyKeys`). Countries stay global.
