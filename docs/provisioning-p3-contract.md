# Provisioning P3 contract (prerequisite — not yet active)

Status: prerequisites built on review branches. Nothing here is wired to a route, consumer or timer; no
distributed provisioning runs until P3 activation is approved.

## 1. Canonical step key (frozen, v2)

```
psk2:<runId>:<service>:<component>:<action>
psk2:2f0c…-uuid:account-service:grid-system-defaults:ensure-defaults
```

- Inputs: the run's uuid (never reused; one run per tenant + template version), the registered component key
  (`<service>:<component>`, the service appears once) and the component kind's action (`grid-system-defaults` →
  `ensure-defaults`). Nothing else — no organisation code, Entra tid, email/domain, tenant display data or labels.
- Lowercase `[a-z0-9-]` segments, `:` separated, ≤ 128 chars. Attempts are not part of the key.
- Code: `constants/provisioningStepKeys.js` (`buildStepKey`, `parseStepKey`, `eventIdFor`).

**Legacy v1** (`<tenantId>:<templateKey>@<version>:<service>:<component>`, e.g. the kept P2 proof run
`…d6f49f`): keys stay immutable and are never rewritten. Such runs have no `stepKeyVersion` (= 1); the
orchestrator, `recordStepResult` and audit-service refuse them (`LEGACY_STEP_KEY_VERSION` / `INVALID_STEP_KEY`).
New runs are created with `stepKeyVersion: 2`.

**Event id**: `prov_<sha256(eventType | stepKey | attempt)[0..40]>` — one logical event per step and run attempt; a
resumed run (attempt + 1) is a new logical request.

## 2. Events (exchange `provisioning.events`, topic, durable — rabbitmq-middleware M1)

| Event | Producer | Consumer | Purpose |
|---|---|---|---|
| `tenant.provisioning.step.requested.v1` | user-service outbox publisher | the step's owning service (filters `data.service` = itself) | run one step |
| `tenant.provisioning.step.completed.v1` | owning service | user-service orchestrator | step succeeded (counts) |
| `tenant.provisioning.step.failed.v1` | owning service | user-service orchestrator | step failed (fixed code) |

No run-level events (run state is user-service internal); nothing added for symmetry.

Envelope (middleware `publishConfirmed`): `eventId` (deterministic, also AMQP `messageId`), `eventType`,
`timestamp`, `correlationId` (= step key), **`tenantId` = internal target tenant** (+ `x-tenant-id` header).

`requested.data` (exact, strict — `models/provisioningOutbox.model.js`): `runId, tenantId, stepKey,
stepKeyVersion (2), service, component, action, manifestVersion, manifestSha256, attempt, templateKey,
templateVersion`.

`completed.data`: `runId, tenantId, stepKey, service, component, attempt, manifestSha256, insertedCount,
skippedCount`. `failed.data`: same ids + `failureCode` ∈ `SERVICE_UNAVAILABLE | TIMEOUT |
MANIFEST_VERSION_UNSUPPORTED | MANIFEST_DIGEST_MISMATCH | TENANT_ID_REJECTED | ANOMALY_REFUSED | STEP_ERROR`.

Forbidden in every payload: tokens, secrets, credentials, emails, names, organisation codes, Entra tids /
directory ids, domains, error messages / stack traces, tenant data (columns, filters, rows).

## 3. Tenant boundary

The internal ProjectShell tenantId is the only ownership value. Every consumer verifies
`envelope.tenantId = data.tenantId = run (or step) target tenant` and fails closed on mismatch. Organisation code,
Entra tid, email/domain and caller headers are never authority.

## 4. Transactional outbox (user-service)

`requestNextStep` runs in one MongoDB transaction: the next pending step → `running` (attempts + 1), run →
`running`, history `step-requested`, **and** the outbox row. Both commit or neither. A step already running returns
its existing event (no new row). Unique indexes: `eventId`; `(eventType, stepKey, attempt)`. Requires a replica set
(Atlas is one).

## 5. Publisher (user-service)

`services/provisioningOutboxPublisher.js` — separate from requests; started only by `startOutboxPublisher()` with
`PROVISIONING_OUTBOX_PUBLISHER=on`, called once at boot by `services/provisioningOutboxBoot.js` after the event system
is initialised (flag absent → no timer; no broker URL → not started; stopped on SIGINT/SIGTERM). Lease → `publishConfirmed` → mark `published` only after broker ack (CAS).
Failure: attempts + 1, fixed `lastErrorCode`, backoff 5 s·2ⁿ (≤ 5 min), `dead` after 12 (kept, observable). A crash
between ack and mark re-publishes the same eventId. Refuses to run on a middleware without `publishConfirmed`.

## 6. Owning-service consumer contract (P4, per service, one batch each)

On `step.requested`:

1. Ignore unless `data.service` is this service; refuse unknown `component`/`action`.
2. Tenant triple (§3) and `stepKeyVersion === 2`, `parseStepKey(stepKey).runId === data.runId`.
3. **Manifest hash (mandatory)**: sha256 of the manifest file this service ships must equal
   `data.manifestSha256`, and the manifest `version` must equal `data.manifestVersion`. Mismatch → no write, emit
   `step.failed` with `MANIFEST_DIGEST_MISMATCH` (or `MANIFEST_VERSION_UNSUPPORTED`). A version-only match is never
   enough. (Today's `ensureTenantDefaults` checks the version only — the digest check is added in P4.)
4. `ensureTenantDefaults(tenantId, manifestVersion)` — insert missing only, skip existing, never update, never
   tenantless, idempotent.
5. Emit `step.completed` with `insertedCount` / `skippedCount` (or `step.failed` with a fixed code).
6. Deduplicate by `eventId` / `stepKey + attempt`: a redelivery re-runs the idempotent ensure (inserts 0) and
   re-emits the same result; the orchestrator acknowledges it as `DUPLICATE`.

## 7. Orchestrator result handling (user-service)

`services/provisioningOrchestrator.js handleStepResultEvent` — refuses (no write): malformed / unknown type,
tenant mismatch, unknown run, legacy or foreign step key, service/component mismatch, stale attempt, step not
requested (out-of-order), conflicting result for a finished step. Duplicate → `DUPLICATE`. Digest mismatch on a
completion → step **failed** `MANIFEST_DIGEST_MISMATCH`. Audit: `platform.provisioning.step.changed.v1`
(system actor `platform:provisioning`, target = run tenant; audit-service narrow exception).

## 8. Failure model

| Scenario | Behaviour |
|---|---|
| Broker unavailable / publish timeout / nack | row stays `pending`, backoff, `dead` after 12; run step stays `running` |
| Duplicate delivery (requested) | consumer re-runs idempotent ensure; same result event |
| Duplicate delivery (result) | `DUPLICATE` only if identical (outcome, digest, counts / code); otherwise `RESULT_CONFLICT`; no write |
| Consumer crash before write | no ack → redelivery → normal processing |
| Consumer crash after write, before ack | redelivery → ensure inserts 0 → same completion |
| Manifest hash mismatch | consumer: no write + `failed MANIFEST_DIGEST_MISMATCH`; orchestrator: a completion with a foreign digest fails the step |
| Wrong tenant | refused at both ends, nothing written |
| Unknown run / legacy run | refused |
| Stale attempt | refused (the current attempt has its own event id) |
| Out-of-order / repeated completion | refused / `DUPLICATE` |
| Permanent consumer failure | `step.failed` → run `failed` (later steps not started) → platform resume = attempt + 1 |

No scenario updates an existing tenant default, moves ownership, creates tenantless rows, users, roles or platform
permissions.

## 9. Open decisions before activation

- **DEVTENANTB slot** (decided 2026-11-01: the first P3 proof uses a NEW disposable DEV tenant; the P2 run stays
  untouched history): the unique `(tenantId, templateKey, templateVersion)` slot for DEVTENANTB /
  `standard-tenant@1` is held by the legacy v1 P2 run (never rewritten, never dispatchable). A first real P3 run
  therefore needs another target (e.g. the roadmap's P6 throwaway tenant), a `standard-tenant` v2, or an
  explicitly reviewed supersede mechanism for legacy runs.
- **Stuck `running` step** (decided 2026-11-01, implemented): no generic requeue. Platform route
  `POST /api/platform/provisioning/tenants/:targetTenantId/runs/:runId/recover-delivery` `{ stepKey, attempt }`
  (platform:provisioning:admin): if the outbox row of the SAME run / step key / attempt is `dead` and the step is
  still `running`, one transaction fails step + run with the fixed code `OUTBOX_DELIVERY_EXHAUSTED` (history
  `delivery-exhausted`, step audit). Idempotent; anything else refused. The dead row stays as evidence; platform
  resume then starts a new attempt with a new event id. Services can never report this code.

## 10. Not done here (P3 activation / P4)

Wiring (dispatch trigger, publisher start, user-service result consumer), service consumers + digest check (P4),
middleware adoption (pin the M1 SHA per service), audit-service #10 deploy, DEV broker confirm proof.
