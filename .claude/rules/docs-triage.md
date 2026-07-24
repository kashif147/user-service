# Which docs are actually worth reading

There is no `README.md` — only ~45 markdown files at the repo root and under `docs/`, most of which
are stale point-in-time implementation logs, staging run-reports, or superseded design docs. Don't
read broadly; go straight to the file for the subsystem you need:

- **RBAC/policy model**: `docs/DEVELOPER-HANDOFF-GUIDE.md` + `docs/PDP-IMPLEMENTATION-SUMMARY.md` are
  accurate and describe the actually-live code path (`helpers/policyAdapter.js`). Ignore the other
  ~19 RBAC-titled docs (`RBAC-*`, `CENTRALIZED-RBAC-*`, `SDK-USAGE-GUIDE.md`,
  `POLICY-CLIENT-ARCHITECTURE.md`, `COMPATIBILITY-*`, `PDP-MIGRATION-TESTING-GUIDE.md`, etc.) — they
  document an external-consumer SDK contract (`sdks/node-policy-client.js`) that this codebase itself
  barely uses (see `rbac-engine.md`).
- **Lookup/hierarchy**: `docs/LOOKUP-HIERARCHY-API.md`. `docs/LOOKUP-API-ENDPOINTS.md` has stale
  route paths (says `/api/lookups`/`/api/lookuptypes` plural; actual routes are singular
  `/api/lookup`/`/api/lookuptype`) — don't trust it, use `lookup-hierarchy.md` or the code instead.
- **Product/pricing**: `docs/PRODUCT-MANAGEMENT-API.md` — accurate.
- **Azure B2C `Content-Type` fix**: `QUICK_FIX_SUMMARY.md` (same content as `AZURE_B2C_INTEGRATION.md`
  and `FINAL_ANALYSIS.md` — read the shortest one). None of the three cover the full OAuth flow, just
  one specific header bug.
- **`DUPLICATE_DETECTION.md` is stale**: it describes in-process duplicate checks that have since
  moved to profile-service; `controllers/user.controller.js`'s `/api/users/validate` now just
  forwards to profile-service's `/api/profile/validate`.
- **`AZURE_B2C_COMPATIBILITY.md` isn't a doc at all** — it's a pasted internal email about change
  prioritization. Skip it.
- Everything else at the repo root and under `docs/` (permission-setup confirmations,
  role-assignment summaries, staging bootstrap logs, CORS deployment notes, cleanup summaries) is a
  dated operational run-log from a specific staging session, not living architecture reference —
  don't cite it as current behavior without checking the code first.
