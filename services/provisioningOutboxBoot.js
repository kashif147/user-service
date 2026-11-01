/**
 * Boot wiring for the provisioning outbox publisher (services/provisioningOutboxPublisher.js).
 *
 * Default OFF: startOutboxPublisher() itself refuses unless PROVISIONING_OUTBOX_PUBLISHER=on, so with the flag absent
 * no timer exists and nothing is published. Called once from bin/user-service.js, only after initEventSystem()
 * succeeded (a publisher without a broker connection would only burn retry attempts).
 *
 * The publisher only drains rows already written to provisioningoutbox by requestNextStep(); it never creates a run,
 * never requests a step and never dispatches anything by itself (no implicit dispatch).
 *
 * Shutdown: the interval is stopped on SIGINT (before app.js's existing exit handler) and on SIGTERM (then the signal
 * is re-raised so the default termination still happens). A row interrupted between broker ack and the "published"
 * mark is re-published later with the SAME eventId; consumers deduplicate by eventId / step key (result ledger).
 */
const outboxPublisher = require("./provisioningOutboxPublisher");

let signalsWired = false;

function wireOutboxPublisher({ publisher = outboxPublisher, proc = process, env = process.env, intervalMs } = {}) {
  // initEventSystem() returns without error when no broker URL is configured; never start a publisher without one.
  if (env.PROVISIONING_OUTBOX_PUBLISHER === "on" && !(env.RABBITMQ_URL || env.RABBIT_URL)) {
    console.warn("[provisioning-outbox] publisher not started (PROVISIONING_OUTBOX_PUBLISHER=on but RABBITMQ_URL is not set)");
    return { started: false, reason: "RABBITMQ_URL not set" };
  }
  const result = publisher.startOutboxPublisher(intervalMs ? { intervalMs } : undefined);
  if (!result.started) {
    if (result.reason === "already started") console.warn("[provisioning-outbox] publisher already started - not starting a second timer");
    else console.log("[provisioning-outbox] publisher not started (PROVISIONING_OUTBOX_PUBLISHER is not 'on')");
    return result;
  }
  console.log("[provisioning-outbox] publisher started (PROVISIONING_OUTBOX_PUBLISHER=on)");
  if (!signalsWired) {
    signalsWired = true;
    const stop = () => publisher.stopOutboxPublisher();
    proc.prependListener("SIGINT", stop);
    proc.once("SIGTERM", () => {
      stop();
      proc.kill(proc.pid, "SIGTERM");
    });
  }
  return result;
}

module.exports = { wireOutboxPublisher };
