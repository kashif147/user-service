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
