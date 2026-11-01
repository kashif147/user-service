/**
 * Boot wiring for the provisioning outbox publisher (services/provisioningOutboxPublisher.js).
 *
 * Default OFF: startOutboxPublisher() itself refuses unless PROVISIONING_OUTBOX_PUBLISHER=on, so with the flag absent
 * no timer exists and nothing is published. Called once from bin/user-service.js, only after initEventSystem()
 * succeeded. Fails closed when no broker URL is configured (initEventSystem() returns without error in that case).
 *
 * The publisher only drains rows already written to provisioningoutbox by requestNextStep(); it never creates a run,
 * never requests a step and never dispatches anything by itself (no implicit dispatch).
 *
 * Shutdown: no signal handlers are added here - the application's existing shutdown path stays authoritative
 * (app.js SIGINT -> process.exit(0); SIGTERM -> default termination). The timer is unref'd, so it never keeps the
 * process alive, and it ends with the process. A row interrupted between broker ack and the "published" mark is
 * re-published later with the SAME eventId; consumers deduplicate by eventId / step key (result ledger).
 * stopOutboxPublisher() remains available for programmatic shutdown.
 */
const outboxPublisher = require("./provisioningOutboxPublisher");

function wireOutboxPublisher({ publisher = outboxPublisher, env = process.env, intervalMs } = {}) {
  if (env.PROVISIONING_OUTBOX_PUBLISHER === "on" && !(env.RABBITMQ_URL || env.RABBIT_URL)) {
    console.warn("[provisioning-outbox] publisher not started (PROVISIONING_OUTBOX_PUBLISHER=on but no broker URL is configured)");
    return { started: false, reason: "RABBITMQ_URL not set" };
  }
  const result = publisher.startOutboxPublisher(intervalMs ? { intervalMs } : undefined);
  if (!result.started) {
    if (result.reason === "already started") console.warn("[provisioning-outbox] publisher already started - not starting a second timer");
    else console.log("[provisioning-outbox] publisher not started (PROVISIONING_OUTBOX_PUBLISHER is not 'on')");
    return result;
  }
  console.log("[provisioning-outbox] publisher started (PROVISIONING_OUTBOX_PUBLISHER=on)");
  return result;
}

module.exports = { wireOutboxPublisher };
