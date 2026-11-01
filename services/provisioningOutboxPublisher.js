/**
 * Phase B / P3 prerequisite: the provisioning outbox publisher - SEPARATE from run creation / step requests.
 * NOT started by the service in this change: startOutboxPublisher() must be called explicitly AND requires
 * PROVISIONING_OUTBOX_PUBLISHER=on (P3 activation wires it after review). No hidden fire-and-forget publishing.
 *
 * publishDueOnce({ limit, now, publishFn })
 *   For each due pending row (status pending, nextAttemptAt <= now, lease free): take a short lease, publish with
 *   rabbitmq-middleware publisher.publishConfirmed (deterministic eventId, internal tenantId, resolves only on
 *   BROKER ACK), then mark published (compare-and-set on eventId + status pending). On nack / timeout / channel
 *   error: publishAttempts + 1, lastErrorCode (fixed codes), exponential backoff (5 s * 2^n, max 5 min); after
 *   MAX_ATTEMPTS the row becomes "dead" (kept, observable, never dropped). A crash after the broker ack but before
 *   the mark re-publishes the SAME eventId later - consumers deduplicate by eventId / step key.
 * Fails closed if the installed middleware has no publishConfirmed (MIDDLEWARE_CONFIRM_UNAVAILABLE): nothing is
 * published with the legacy non-confirmed publish().
 */
const ProvisioningOutbox = require("../models/provisioningOutbox.model");

const MAX_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const LEASE_MS = 30000;
const backoff = (n) => Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, n - 1), MAX_BACKOFF_MS);

function errorCode(res) {
  const e = String((res && res.error) || "");
  if (/nack/i.test(e)) return "BROKER_NACK";
  if (/timeout/i.test(e)) return "CONFIRM_TIMEOUT";
  if (/channel|connect/i.test(e)) return "CHANNEL_UNAVAILABLE";
  return "PUBLISH_ERROR";
}

function defaultPublishFn(middleware = require("@projectShell/rabbitmq-middleware")) {
  const { publisher } = middleware || {};
  if (!publisher || typeof publisher.publishConfirmed !== "function") return null;
  return (eventType, data, options) => publisher.publishConfirmed(eventType, data, options);
}

const log = (event, extra) => console.info("[provisioning-outbox]", JSON.stringify({ event, ...extra }));

async function publishDueOnce({ limit = 20, now = new Date(), publishFn, middleware } = {}) {
  const fn = publishFn || defaultPublishFn(middleware);
  const summary = { published: 0, retried: 0, dead: 0, skipped: 0 };
  if (!fn) {
    log("provisioning.outbox.blocked", { code: "MIDDLEWARE_CONFIRM_UNAVAILABLE" });
    return { ...summary, blocked: "MIDDLEWARE_CONFIRM_UNAVAILABLE" };
  }
  const due = await ProvisioningOutbox.find({ status: "pending", nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  for (const row of due) {
    const lease = await ProvisioningOutbox.updateOne(
      { eventId: row.eventId, tenantId: row.tenantId, status: "pending", $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
      { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } }
    );
    if (lease.modifiedCount !== 1) { summary.skipped += 1; continue; } // another publisher holds it
    let res;
    try {
      res = await fn(row.eventType, row.payload, { eventId: row.eventId, tenantId: row.tenantId, correlationId: row.stepKey, metadata: { service: "user-service" } });
    } catch (e) {
      res = { success: false, error: e && e.message };
    }
    if (res && res.success === true) {
      await ProvisioningOutbox.updateOne({ eventId: row.eventId, tenantId: row.tenantId, status: "pending" }, { $set: { status: "published", publishedAt: new Date(), leaseUntil: null, lastErrorCode: null } });
      summary.published += 1;
      log("provisioning.outbox.published", { eventId: row.eventId, eventType: row.eventType });
      continue;
    }
    const attempts = row.publishAttempts + 1;
    const code = errorCode(res);
    const dead = attempts >= MAX_ATTEMPTS;
    await ProvisioningOutbox.updateOne(
      { eventId: row.eventId, tenantId: row.tenantId, status: "pending" },
      { $set: { status: dead ? "dead" : "pending", publishAttempts: attempts, lastErrorCode: code, leaseUntil: null, nextAttemptAt: new Date(now.getTime() + backoff(attempts)) } }
    );
    summary[dead ? "dead" : "retried"] += 1;
    log(dead ? "provisioning.outbox.dead" : "provisioning.outbox.retry", { eventId: row.eventId, code, attempts });
  }
  return summary;
}

let timer = null;
function startOutboxPublisher({ intervalMs = 5000 } = {}) {
  if (process.env.PROVISIONING_OUTBOX_PUBLISHER !== "on") return { started: false, reason: "PROVISIONING_OUTBOX_PUBLISHER is not 'on'" };
  if (timer) return { started: false, reason: "already started" };
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await publishDueOnce(); } catch (e) { log("provisioning.outbox.error", { error: e && e.name }); } finally { busy = false; }
  }, intervalMs);
  timer.unref();
  return { started: true };
}
function stopOutboxPublisher() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { publishDueOnce, startOutboxPublisher, stopOutboxPublisher, defaultPublishFn, MAX_ATTEMPTS, backoff };
