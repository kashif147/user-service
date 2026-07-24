# Role/Permission data model

`Role.permissions` is an embedded array that's **mixed-type in the database** — some entries are
24-char hex `Permission` ObjectId strings, others are literal permission `code` strings, and both
forms coexist across existing documents. `handlers/role.handler.js` explicitly regex-tests each entry
and resolves accordingly wherever it reads this field — don't assume one representation when writing
new code against it; test both.

There are also **two independent "effective permissions for a user" implementations** that must be
changed together:

- `role.handler.js`'s `getUserPermissions` — used by controllers, no caching.
- `permissionsService.js`'s Redis-cached equivalent — used internally by `roleHierarchyService` and
  similar.

A change to permission-resolution logic made in only one of these will make them diverge.

`roleHierarchyService`'s "hierarchy" is a flat numeric `level` per role code (`SU:100, ASU:95, GS:90,
… MEMBER/NON-MEMBER:1`, merged from DB roles onto a hardcoded fallback list), used purely for
privilege-level comparison (`hasMinimumRole`) — there is no parent/child role inheritance despite the
name.

`routes/role-policy.routes.js` is a second, unmounted implementation of role routes built on the
mostly-dead `sdks/node-policy-client.js` (see `rbac-engine.md`) — don't confuse it with the live
`routes/role.routes.js`.
