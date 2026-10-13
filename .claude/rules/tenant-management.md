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
creates the user in that tenant keyed by `{tenantId, userMicrosoftId}` only when the connection has
`autoProvisionUsers: true`. Users in other tenants are never read, moved or created.

**CRM without `?tenant` / B2C portal (fallback):** `resolveApplicationTenant` finds the user (oid,
then email) among the tenants that trust the directory and uses that user's own `tenantId`, never
rewriting it. The CRM no-code path is existing-users-only (`allowProvisioning: false`; to be retired
once every CRM entry point resolves an organisation first). B2C provisions first-login users only into
the single trusting tenant whose connection has `autoProvisionUsers: true` (zero or several -> 403).
The B2C sign-up connector (`helpers/b2cConnectorTenant.js`) follows the same flag.

## Provisioning rules (Phase 2a, `helpers/connectionDefaultRole.js`)

- `autoProvisionUsers`: only explicit `true` is automatic; `false` **or unset** = pre-authorised users
  only (the schema has no default on purpose). Existing users sign in regardless of the flag.
- `defaultRoleId` (per connection): the role a JIT user gets, written in the same atomic insert (a
  role-less user is never created). It must be a role of the same organisation, active, of the
  connection's user type (Entra -> CRM, B2C -> PORTAL), not SU/ASU/`isSystemRole`/category SYSTEM,
  without reserved permissions (`isReservedPermission`). Role `level` is NOT a privilege signal
  (DEV DEVTENANTB's SU/ASU have level 1).
- Every connection write path enforces this (400): POST/PUT `/tenants/:id/auth-connections`, POST
  `/tenants` and PUT `/tenants/:id` with a full `authenticationConnections` array (what the CRM
  Tenant Management form sends) - only new/changed connections are validated, unknown fields are
  dropped. An automatic connection needs a default role, so it cannot be created together with a new
  organisation (its roles do not exist yet). The role picker uses
  `GET /tenants/:id/auth-connections/default-role-options?connectionType=...`.
- At sign-in a configured but unusable default role refuses JIT. **2a migration only:** an automatic
  connection without `defaultRoleId` falls back to REO (CRM) / NON-MEMBER (portal) and logs an
  id-only `LEGACY_DEFAULT_ROLE` warning; Phase 2b removes that fallback, and must not be deployed to
  an environment until a read-only check shows every automatic connection there has a valid role.
- Existing users: `isActive: false` -> 403 (CRM and portal); zero ACTIVE roles of the organisation ->
  403 "You don't have access to this organisation", before any update, role sync or token. Roles are
  never restored at sign-in. Note: the membership promotion/approval/demotion listeners still set
  MEMBER/NON-MEMBER regardless of the user's current roles (unchanged).
