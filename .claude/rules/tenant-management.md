# Tenant management

`models/tenant.model.js`'s `authenticationConnections[]` is how one tenant maps to one-or-more Azure
AD/B2C directories — a tenant is not necessarily backed by a single Azure directory.

**Connection model (approved architecture, Stage 4).** A connection identifies the customer's
DIRECTORY (`directoryId` = Microsoft Directory (tenant) ID / `tid`); the application is fixed server
configuration (`helpers/authAppRegistry.js`: `entraCrm` = the one shared CRM app registration, same
Application (client) ID for every organisation; `legacySharedB2C` for the shared B2C portal). The
customer is distinguished by directory, never by client id, scope, audience or appRef; the
ProjectShell `tenantId` stays the isolation boundary. Fields (`helpers/connectionDefaultRole.js`):
- Admin-writable (the only fields a request body may set): `connectionType`, `directoryId`,
  `isActive`, `autoProvisionUsers`, `defaultRoleId`, and the legacy `issuerUrl` / `audience`
  (optional, never read for sign-in; `issuerUrl` validated when supplied; B2C `audience` still feeds
  the sign-up connector).
- Server-managed (never from a request; carried over on every save): `connectedAt`, `connectedBy`,
  `lastTestedAt`, `lastTestResult {ok, code}`.
- Preserved legacy, INERT: `appRef`, `directoryOwnership` (Phase 3B DEV backfill). Never read for
  sign-in, never accepted from a request (new connections never get them), never returned; stored
  values are carried over by `_id` until a controlled cleanup migration. Directory ownership moves
  to directory claims (Stage 5).
- Identity (`assertConnectionIdentity`, on the final proposed list of every write path: create,
  add, update, full-array replace): among active connections at most ONE Microsoft Entra connection
  per organisation and no two connections of the same provider for the same directory
  (case-insensitive). Existing conflicts are grandfathered for unrelated saves; new conflicts or
  edits that create/touch one -> 400. Cross-organisation directory uniqueness is Stage 5.
New or changed connections also pass `assertConnectionWritable` (Entra `directoryId` is a GUID,
issuer rule, provisioning/default-role rules); untouched stored connections are grandfathered.
Responses: every tenant/connection response goes through `helpers/authConnectionView.js` (explicit
allow-list; appRef / directoryOwnership / application configuration are never returned).

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
(`directoryId`); the **application** (client id, redirect URI, scopes, client secret) is fixed server
configuration (`helpers/authAppRegistry.js`: Entra -> `entraCrm` from `AZURE_AD_*`, B2C ->
`legacySharedB2C` from `MS_*`), never from MongoDB, the request or a stored appRef; issuer, JWKS URI
and authorize/token/logout endpoints are derived. The stored `issuerUrl`/`audience` are NOT read for sign-in (DEV holds placeholders
there; `audience` is still what the B2C sign-up connector matches). The secret is non-enumerable on
every resolved object. The CRM authorize URL, token exchange (`exchangeCodeForTokens(code, verifier,
config)`) and ID token verification (`verifyIdToken(token, nonce, config)`: issuer, audience,
`tid` = the connection's directory) all take the resolved config; JWKS are cached per JWKS URI
(directory). The CRM callback ignores any `redirectUri` in the body and the Origin/Referer header -
the redirect URI is always the app registration's.

- **Compatibility mode (default):** an Entra connection is usable only when its `directoryId` equals
  the CRM app's home directory (`AZURE_AD_TENANT_ID`); otherwise `DIRECTORY_NOT_ENABLED` - generic 400
  at `/pkce/generate`, 403 at the callback, before any token request.
- **Multi-directory switch (Stage 5a):** `ENTRA_CRM_MULTI_DIRECTORY` exactly `true` lifts only that
  assertion, only for a selected organisation connection (the no-code path stays home-directory).
  Same shared app (client id, credential, scopes, redirect URI); the connection's directory is
  authoritative and `tid` must equal it. Not to be enabled anywhere before directory claims
  (Stage 5b: cross-organisation uniqueness, verified ownership) and a multi-tenant app registration.
- **Always refused:** non-GUID directories (`common` / `organizations` / `consumers`) and the
  Microsoft personal-account directory `9188040d-6c67-4c5b-b112-36a304b66dad` (`INVALID_DIRECTORY`).
- **Directory claims (Stage 5b, `models/directoryClaim.model.js`):** authoritative for which
  organisation owns a directory (`connection.directoryOwnership` is inert legacy data). Partial
  unique index: one VERIFIED (non-exception) directory -> one organisation; one claim per
  connection and per (organisation, directory); ownership fields immutable; strict schema (no
  client ids, scopes, secrets, tokens or appRef). In multi-directory mode only,
  `helpers/directoryClaimGate.js` requires a verified claim matching directory + organisation +
  connection at login start, again at the callback, and when a connection write activates/changes
  an Entra connection (new connections must be saved inactive first) - else
  `DIRECTORY_NOT_CLAIMED`. Switch off: no claim is read. No tenant-admin claim API exists; claims
  come from the Stage 5c admin connection flow or a controlled platform/DEV operation.
- **Connect Microsoft Entra (Stage 5c-1, `handlers/entraConnect.handler.js`):**
  `POST /tenants/:id/auth-connections/:connectionId/connect` (tenant admin, own tenant) returns an
  authorize URL for the shared CRM app on the `organizations` authority (code + PKCE S256, scopes
  `openid profile email`, no refresh token); `.../connect/complete` `{code, state}` takes the
  single-use server-side `entra-connect` state (`helpers/pkceStateStore.js`: separate from sign-in
  states; bound to tenant, connection, directory snapshot, initiating user, nonce, verifier),
  verifies the ID token (`helpers/entraConnect.js`: signature, audience, issuer of the token's own
  tid, nonce, exp/nbf, iat <= 10 min, tid not the consumer directory, oid GUID), requires
  `tid == connection.directoryId` (`DIRECTORY_MISMATCH`, never overwritten) and a signed `wids`
  administrator role (Global / Privileged Role / Cloud Application / Application Administrator,
  else `NOT_DIRECTORY_ADMIN`), records a verified `entra-admin-sign-in` claim with
  `verificationEvidence {directoryUserId, roleTemplateId}` (`helpers/directoryClaimService.js`;
  DEV exceptions -> `DIRECTORY_SHARED_EXCEPTION`, another org's -> `DIRECTORY_ALREADY_CLAIMED`) and
  sets only `connectedAt`/`connectedBy` (never `isActive`, the directory or test fields).
  `GET .../status` is derived: `not_connected` / `connected` / `reconnect_required` / `test_failed`.
  Body/query identity fields are ignored; no token, code or verifier is stored or logged. `wids` is
  emitted only when the app registration's `groupMembershipClaims` includes directory roles. The
  redirect URI is the existing registered CRM one (compatibility until the central callback).
- **DEV shared-directory exception** (`helpers/directoryClaimPolicy.js`): method `dev-exception`,
  valid only while `DEPLOYMENT_ENV=dev`, `ENTRA_ALLOW_SHARED_DIRECTORY=true` and the directory is in
  `ENTRA_SHARED_DIRECTORY_ALLOWLIST` (NODE_ENV is never used). Either override variable set
  outside `DEPLOYMENT_ENV=dev` (or a malformed allow-list) stops the service at startup.
- **Without a connection** (CRM login without an organisation code, and logout) the home directory is
  used. That path is existing-users-only and cannot support several directories: it is to be retired
  or redesigned with multi-directory sign-in.
- **Azure B2C** resolves the legacy shared ProjectShell B2C directory/app (no connection; the portal
  selects no organisation), per user flow. No hardcoded tenant/client/redirect fallbacks: missing
  `MS_TENANT_NAME`/`MS_CLIENT_ID`/`MS_REDIRECT_URI`/`MS_B2C_DIRECTORY_ID` fails closed (the CRM
  sign-in start still works without them). Shared B2C is a compatibility arrangement; the target is
  per-organisation member identity (B2C or External ID; portal and mobile of one organisation may
  share one connection), each with its own Application (client) ID - not appRef.

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
