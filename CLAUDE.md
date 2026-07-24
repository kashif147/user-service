# CLAUDE.md

## What this service is

`user-service` is the platform's authorization root: it hosts the RBAC Policy Decision Point
(`/policy/evaluate`, what every other service's `POLICY_SERVICE_URL` points at), Azure AD/B2C login
and user provisioning, tenant/branding/office/department/lookup management, and product/pricing
management. Port `5001` (matches `.env.common`'s `POLICY_SERVICE_URL=http://user-service:5001`
default used platform-wide). There is no `README.md` — see `docs-triage.md` before reading any of the
~45 markdown files at the repo root/`docs/`.

The one thing to internalize before touching authorization code: several parallel/dead RBAC code
paths coexist here, and only two are actually live — see `rbac-engine.md` before assuming a file you
found is the one handling a given request.

## Commands

```bash
npm run start:dev              # NODE_ENV=development node ./bin/user-service.js
npm run dev                     # nodemon, development
npm run dev:staging             # nodemon, staging
npm run setup-rbac              # scripts/setup-rbac.js — seed roles/permissions
npm run assign-roles            # scripts/assign-default-roles-enhanced.js
npm run assign-roles:dry-run    # --dry-run
npm run seed-countries           # scripts/seed-countries.js
```

**Testing is largely broken — don't trust the npm scripts.** `tests/` contains exactly one real test
(`tests/application.approval.listener.test.js`, run via plain `jest`). `npm run test-me-integration`
points at `tests/me-endpoint-integration.test.js`, which does not exist anywhere in this repo — running
it fails immediately. `npm run test-me` points at `test-me-endpoint.sh`, which also isn't present at
the repo root. The other `test-*` scripts (`test-roles`, `test-auth`, etc.) are plain `node
scripts/*.js` smoke scripts, not a real jest suite.

## Which docs are actually worth reading
@.claude/rules/docs-triage.md

## RBAC engine — which implementation is live
@.claude/rules/rbac-engine.md

## Role/Permission data model
@.claude/rules/role-permission-model.md

## Tenant management
@.claude/rules/tenant-management.md

## Lookup / hierarchy system
@.claude/rules/lookup-hierarchy.md

## Product / Pricing management
@.claude/rules/product-pricing.md

## Azure AD B2C login
@.claude/rules/azure-b2c-auth.md

## RabbitMQ
@.claude/rules/rabbitmq.md
