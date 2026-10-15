# Tenant management

`models/tenant.model.js`'s `authenticationConnections[]` is how one tenant maps to one-or-more Azure
AD/B2C directories — a tenant is not necessarily backed by a single Azure directory.

**Connection fields (Phase 3B).** Admin-writable (the only fields a request body may set, list
`ADMIN_WRITABLE_CONNECTION_FIELDS` in `helpers/connectionDefaultRole.js`): `connectionType`,
`directoryId`, `isActive`, `autoProvisionUsers`, `defaultRoleId`, `appRef` (a registered application
of the connection's provider, `helpers/authAppRegistry.js`; unset = the compatibility default
crm-entra / portal-b2c), `directoryOwnership` (Entra: `customer` | `shared-nonprod`; B2C: `customer` |
`projectshell-shared` - recorded only, no uniqueness rule yet), and the legacy `issuerUrl` / `audience`
(optional, never read for sign-in; `issuerUrl` validated when supplied). Server-managed (never from a
request; carried over on every save): `connectedAt`, `connectedBy`, `lastTestedAt`, `lastTestResult
{ok, code}`. Every write path (tenant create/update incl. the CRM form's full-array replace, add/update
connection) keeps admin-writable fields a client did not send and all server-managed fields, drops
unknown fields, and validates new or changed connections only (`assertConnectionWritable`: Entra
`directoryId` must be a GUID, appRef/ownership/issuer rules, provisioning rules) - untouched stored
connections are grandfathered. Responses: every tenant/connection response goes through
`helpers/authConnectionView.js` (explicit field allow-list + `effectiveAppRef`); nothing from the app
registry (client ids, redirect URIs, secret references) is ever returned. No secret is stored on a
connection.

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
single active Entra connection (none or several -> the same generic 400; never chosen by the env
directory) and stores `{tenantId, connectionId}` next to the nonce under the random, single-use
OAuth `state` (`helpers/pkceStateStore.js`). The callback restores it from the state only
(`takeLoginTransaction`, then `loadLoginConnection`); body/query/`x-tenant-id` are never read.
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
The B2C sign-up connector (`helpers/b2cConnectorTenant.js`) follows the same flag and also requires
the connection to have a `defaultRoleId` (presence only; the role is validated at provisioning), so a
B2C account is never created for a connection whose first sign-in would refuse JIT.

## Protocol configuration (`helpers/connectionAuthConfig.js`, Phase 3A)

`resolveConnectionAuthConfig(connection, providerContext)` is the only place that produces a
sign-in's protocol configuration. The **directory** comes from the selected connection
(`directoryId`); the **application** (client id, redirect URI, scopes, client secret) comes from the
server-side app registry (`helpers/authAppRegistry.js`: `crm-entra` -> `AZURE_AD_*`, `portal-b2c` ->
`MS_*`), never from MongoDB or the request; issuer, JWKS URI and authorize/token/logout endpoints
are derived. The stored `issuerUrl`/`audience` are NOT read for sign-in (DEV holds placeholders
there; `audience` is still what the B2C sign-up connector matches). The secret is non-enumerable on
every resolved object. The CRM authorize URL, token exchange (`exchangeCodeForTokens(code, verifier,
config)`) and ID token verification (`verifyIdToken(token, nonce, config)`: issuer, audience,
`tid` = the connection's directory) all take the resolved config; JWKS are cached per JWKS URI
(directory). The CRM callback ignores any `redirectUri` in the body and the Origin/Referer header -
the redirect URI is always the app registration's.

- **Compatibility mode:** an Entra connection is usable only when its `directoryId` equals the CRM
  app's home directory (`AZURE_AD_TENANT_ID`); otherwise `DIRECTORY_NOT_ENABLED` - generic 400 at
  `/pkce/generate`, 403 at the callback, before any token request. Multi-directory sign-in removes
  this assertion (plus a multi-tenant app registration, cross-organisation directory uniqueness).
- **Without a connection** (CRM login without an organisation code, and logout) the home directory is
  used. That path is existing-users-only and cannot support several directories: it is to be retired
  or redesigned with multi-directory sign-in.
- **Azure B2C** resolves the legacy shared ProjectShell B2C directory/app (no connection; the portal
  selects no organisation), per user flow. No hardcoded tenant/client/redirect fallbacks: missing
  `MS_TENANT_NAME`/`MS_CLIENT_ID`/`MS_REDIRECT_URI`/`MS_B2C_DIRECTORY_ID` fails closed (the CRM
  sign-in start still works without them). Shared B2C is a compatibility arrangement; the target is
  per-organisation member identity (B2C or External ID; portal and mobile of one organisation may
  share one connection), resolved through a connection + appRef later.

## Provisioning rules (`helpers/connectionDefaultRole.js`)

- `autoProvisionUsers`: only explicit `true` is automatic; `false` **or unset** = pre-authorised users
  only (the schema has no default on purpose). Existing users sign in regardless of the flag.
- `defaultRoleId` (per connection): the role a JIT user gets, written in the same atomic insert (a
  role-less user is never created). It must be a role of the same organisation, active, not
  SU/ASU/`isSystemRole`/category SYSTEM, without reserved permissions (`isReservedPermission`), and:
  Entra -> any such CRM-category role (configurable); **Azure B2C -> exactly that organisation's
  NON-MEMBER role** (never MEMBER - portalRoleSync upgrades NON-MEMBER -> MEMBER - and never a staff
  role: existing data gives staff roles such as GS/DIR/AM category PORTAL, so category alone cannot
  decide). Role `level` is NOT a privilege signal (DEV DEVTENANTB's SU/ASU have level 1).
- Every connection write path enforces this (400): POST/PUT `/tenants/:id/auth-connections`, POST
  `/tenants` and PUT `/tenants/:id` with a full `authenticationConnections` array (what the CRM
  Tenant Management form sends) - only new/changed connections are validated, unknown fields are
  dropped. An automatic connection needs a default role, so it cannot be created together with a new
  organisation (its roles do not exist yet). The role picker uses
  `GET /tenants/:id/auth-connections/default-role-options?connectionType=...`.
- **Automatic provisioning requires an explicit configured `defaultRoleId`. There is no legacy
  REO/NON-MEMBER fallback** (removed in Phase 2b): at sign-in a missing default role
  (`NOT_CONFIGURED`) or one that `checkDefaultRole` rejects refuses JIT with a 403, before any user
  write, event or token - for new users and for a legacy portal user being moved into the
  organisation. Existing users never depend on `defaultRoleId`. Before deploying this to an
  environment, a read-only check must show every active automatic connection there has a valid role
  (an automatic connection saved before Phase 2a may have none).
- Existing users: `isActive: false` -> 403 (CRM and portal); zero ACTIVE roles of the organisation ->
  403 "You don't have access to this organisation", before any update, role sync or token. Roles are
  never restored at sign-in. Note: the membership promotion/approval/demotion listeners still set
  MEMBER/NON-MEMBER regardless of the user's current roles (unchanged).
