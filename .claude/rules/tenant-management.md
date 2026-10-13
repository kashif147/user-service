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

## IdP directory vs ProjectShell tenant (sign-in)

The Entra `tid` / B2C directory only validates WHO signed in (`AzureADHandler.verifyIdToken`:
signature, issuer, audience, `tid`, `nonce`). Several ProjectShell tenants may share one directory,
app registration, issuer and audience, so the token can never say which ProjectShell tenant is meant.

**CRM, tenant-scoped (the target flow):** the login is started for a tenant —
`GET /pkce/generate?tenant=<code|_id>` (`helpers/loginTenantContext.js`) resolves that tenant's
active Entra connection for the configured directory and stores `{tenantId, connectionId}` next to
the nonce under the random, single-use OAuth `state` (`helpers/pkceStateStore.js`). The callback
restores it from the state only (`takeLoginTransaction`); body/query/`x-tenant-id` are never read.
`resolveTenantScopedUser` (`helpers/identityTenantResolution.js`) then re-checks the connection is
active and its `directoryId` equals the token `tid`, finds the user ONLY in that tenant by `oid`
(record issuer must be the same directory), else claims an email match that has no real oid yet
(pre-provisioned/legacy; an email match with a different oid is a 403, never a takeover), else JIT
creates the user in that tenant keyed by `{tenantId, userMicrosoftId}` unless the connection has
`autoProvisionUsers: false`. Users in other tenants are never read, moved or created.

**CRM without `?tenant` / B2C portal (fallback):** `resolveApplicationTenant` finds the user (oid,
then email) among the tenants that trust the directory and uses that user's own `tenantId`, never
rewriting it; first-login provisioning only into the single trusting tenant whose connection has
`autoProvisionUsers !== false` (zero or several -> 403). The B2C sign-up connector
(`helpers/b2cConnectorTenant.js`) follows the same flag.
