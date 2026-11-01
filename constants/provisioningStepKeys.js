/**
 * Phase B / P3 prerequisite: the CANONICAL provisioning step key (v2) and deterministic event ids.
 *
 *   psk2:<runId>:<service>:<component>:<action>
 *   e.g. psk2:2f0c…-uuid:account-service:grid-system-defaults:ensure-defaults
 *
 * Derived only from immutable provisioning inputs: the run's uuid (unique per tenant + template version, never
 * reused), the registered component key (`<service>:<component>`, constants/provisioningComponents.js - the service
 * appears ONCE) and the action of that component kind. No tenant display data, organisation code, Entra tid,
 * email / domain or mutable label. Stable across retries and restarts (attempts are NOT part of the key: one
 * key = one logical step of one run); unique per run / component / action. Safe as an outbox / message /
 * consumer-dedup / audit correlation key: lowercase [a-z0-9-] segments separated by ":", <= 128 chars.
 *
 * Legacy (v1, the kept P2 proof run …d6f49f): `<tenantId>:<templateKey>@<version>:<service>:<component>` (the
 * service repeated by the component key). v1 keys stay IMMUTABLE on the runs that have them (never rewritten);
 * such runs carry no stepKeyVersion (= 1) and are refused for dispatch (LEGACY_STEP_KEY_VERSION). Only runs
 * created with stepKeyVersion 2 can be dispatched.
 *
 * Event id (outbox idempotency + consumer dedup): prov_<sha256(eventType | stepKey | attempt)[0..40]> - the same
 * logical event (same step, same run attempt) always has the same id; a resumed run (attempt + 1) is a new
 * logical request with a new id.
 */
const crypto = require("crypto");

const STEP_KEY_VERSION = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STEP_KEY_V2 = /^psk2:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-z0-9-]+):([a-z0-9-]+):([a-z0-9-]+)$/;
// Action per component kind (one action per kind today).
const ACTIONS = Object.freeze({ "grid-system-defaults": "ensure-defaults" });

function buildStepKey(runId, componentKey, action) {
  if (!UUID.test(String(runId))) throw new Error("step key: runId must be a uuid");
  const [service, component, ...rest] = String(componentKey).split(":");
  if (rest.length || !SEGMENT.test(service || "") || !SEGMENT.test(component || "")) throw new Error("step key: componentKey must be <service>:<component>");
  if (!SEGMENT.test(String(action))) throw new Error("step key: invalid action");
  const key = `psk2:${runId}:${service}:${component}:${action}`;
  if (key.length > 128) throw new Error("step key too long");
  return key;
}

/** { version: 2, runId, service, component, action } | { version: 1 } (legacy, opaque) | null (malformed). */
function parseStepKey(key) {
  const m = STEP_KEY_V2.exec(String(key));
  if (m) return { version: 2, runId: m[1], service: m[2], component: m[3], action: m[4] };
  if (/^[0-9a-f]{24}:[a-z][a-z0-9-]*@\d+:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/.test(String(key))) return { version: 1 };
  return null;
}

function actionFor(kind) {
  const a = ACTIONS[kind];
  if (!a) throw new Error(`no provisioning action for component kind ${kind}`);
  return a;
}

function eventIdFor(eventType, stepKey, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be an integer >= 1");
  return `prov_${crypto.createHash("sha256").update(`${eventType}|${stepKey}|${attempt}`).digest("hex").slice(0, 40)}`;
}

module.exports = { STEP_KEY_VERSION, STEP_KEY_V2, ACTIONS, buildStepKey, parseStepKey, actionFor, eventIdFor };
