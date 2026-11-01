/**
 * Child process for tests/provisioning.p4.publisherBoot.test.js: runs the REAL boot wiring + publisher in its own Node
 * process so signal handling / termination is observed for real. Only the database model and the broker are stubbed
 * (via require.cache, before the publisher loads). Every observation is written synchronously to stdout:
 *   READY <wire result>   FIND   PUBLISH <eventId>   MARK <eventId>   SHUTDOWN   provisioning-outbox log lines
 * CHILD_MODE: "ok" (one due row per tick) | "throw" (every outbox query throws) | "noserver" (no HTTP server, so only
 * the publisher timer could keep the process alive) | "twice" (wire called twice).
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const say = (s) => fs.writeSync(1, `${s}\n`);
const mode = process.env.CHILD_MODE || "ok";
let seq = 0;

const modelPath = require.resolve(path.join(__dirname, "..", "..", "models", "provisioningOutbox.model"));
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: {
    find: () => {
      say("FIND");
      if (mode === "throw") throw new Error("outbox query failed");
      seq += 1;
      const row = { eventId: `prov_child_${seq}`, tenantId: "t1", eventType: "tenant.provisioning.step.requested.v1", stepKey: `k${seq}`, payload: {}, publishAttempts: 0 };
      return { sort: () => ({ limit: () => ({ lean: async () => [row] }) }) };
    },
    updateOne: async (filter, update) => {
      if (update.$set && update.$set.status === "published") say(`MARK ${filter.eventId}`);
      return { modifiedCount: 1 };
    },
  },
};
const mwPath = require.resolve("@projectShell/rabbitmq-middleware");
require.cache[mwPath] = {
  id: mwPath, filename: mwPath, loaded: true,
  exports: { publisher: { publishConfirmed: async (type, data, opts) => { say(`PUBLISH ${opts.eventId}`); await new Promise((r) => setTimeout(r, 5)); return { success: true, eventId: opts.eventId }; } } },
};

console.info = (...a) => say(a.join(" "));
console.log = (...a) => say(a.join(" "));
console.warn = (...a) => say(a.join(" "));

// Same shape as app.js's existing shutdown path (the only signal handler in the service).
process.on("SIGINT", async () => {
  say("SHUTDOWN");
  process.exit(0);
});

const { wireOutboxPublisher } = require("../../services/provisioningOutboxBoot");
if (mode !== "noserver") http.createServer().listen(0, "127.0.0.1"); // stands in for the service's HTTP server
say(`READY ${JSON.stringify(wireOutboxPublisher({ intervalMs: 50 }))}`);
if (mode === "twice") say(`READY ${JSON.stringify(wireOutboxPublisher({ intervalMs: 50 }))}`);
say(`SIGNALS SIGINT=${process.listenerCount("SIGINT")} SIGTERM=${process.listenerCount("SIGTERM")}`);
