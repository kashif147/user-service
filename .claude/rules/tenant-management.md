# Tenant management

`models/tenant.model.js`'s `authenticationConnections[]` is how one tenant maps to one-or-more Azure
AD/B2C directories (`{connectionType, issuerUrl, directoryId, audience}`) — a tenant is not
necessarily backed by a single Azure directory.

`tenantLifecycle.controller.js` is a **read-only internal API with no JWT auth at all** — gated only
by `x-internal-request: true`/`"1"` — composing `Tenant.settings.lifecycleBatches` + primary office +
active public holidays + notification-recipient role lookups into one config blob for
`subscription-service`'s reminder/renewal-batch scheduler (`GET
/api/internal/tenant-lifecycle-configs`, `.../lifecycle-config`, `.../notification-recipients`). Any
new internal route added near this one inherits the same exposure: the header check is the *only*
thing standing between it and being a fully open unauthenticated endpoint, so treat it as effectively
public unless real auth is added.

`tenantScoped.controller.js` (`/api/tenant/*`) is not a generic tenant-scoped CRUD helper — it's
specifically a restricted subset of role/permission management for `ASU` admins, re-verifying every
target role belongs to `req.ctx.tenantId` before mutating; it wraps the same
`RoleHandler`/`PermissionHandler` used elsewhere rather than duplicating logic.
